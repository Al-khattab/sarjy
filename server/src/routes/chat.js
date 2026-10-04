import { Router } from "express";
import { groq, MODELS } from "../groq.js";
import { buildSystemPrompt } from "../systemPrompt.js";
import { weatherToolDefinition, getWeather } from "../weather.js";
import {
  getFacts,
  getRecentMessages,
  appendMessage,
  setFacts,
  extractFacts,
} from "../memory.js";

export const chatRouter = Router();

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

chatRouter.post("/", async (req, res) => {
  const userId = req.header("x-user-id");
  const { message } = req.body || {};
  if (!userId)
    return res.status(400).json({ error: "Missing x-user-id header" });
  if (!message) return res.status(400).json({ error: "Missing message" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const t0 = Date.now();
  // Relative to request start, not absolute — avoids comparing the server's
  // clock to the client's clock across the network, which is unreliable.
  const mark = (name) => sse(res, "timing", { name, ms: Date.now() - t0 });

  try {
    // Both memory reads run concurrently instead of sequentially — one
    // Neon round trip saved per turn, for free.
    const [facts, recent] = await Promise.all([
      getFacts(userId),
      getRecentMessages(userId),
    ]);
    mark("memory_loaded");

    const history = recent.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const messages = [
      { role: "system", content: buildSystemPrompt(facts) },
      ...history,
      { role: "user", content: message },
    ];

    // Single streamed call from the start. Most turns never need the
    // weather tool, so this is now the ONLY Groq round trip for the common
    // case. The previous version always paid for a separate, non-streamed
    // "decide if a tool is needed" call before this one, on every turn —
    // this was the single biggest avoidable cost in the pipeline.
    const stream = await groq.chat.completions.create({
      model: MODELS.chat,
      messages,
      tools: [weatherToolDefinition],
      tool_choice: "auto",
      stream: true,
    });

    let full = "";
    let firstToken = false;
    let toolCall = null; // { id, name, args } — accumulated across chunks

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const finishReason = chunk.choices[0]?.finish_reason;

      if (delta?.tool_calls) {
        // NOTE: assumes a single tool call per turn
        const call = delta.tool_calls[0];
        if (!toolCall) {
          toolCall = { id: call.id, name: call.function?.name, args: "" };
        }
        if (call.function?.arguments) toolCall.args += call.function.arguments;
        continue; // tool-call deltas aren't spoken content
      }

      if (delta?.content) {
        if (!firstToken) {
          firstToken = true;
          mark("llm_first_token");
        }
        full += delta.content;
        sse(res, "token", { text: delta.content });
      }

      if (finishReason === "tool_calls" && toolCall) {
        mark("tool_call_detected");
        const args = JSON.parse(toolCall.args || "{}");
        const result = await getWeather(args.location);
        mark("tool_result");

        const followUp = await groq.chat.completions.create({
          model: MODELS.chat,
          stream: true,
          messages: [
            ...messages,
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: toolCall.id,
                  type: "function",
                  function: { name: toolCall.name, arguments: toolCall.args },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            },
          ],
        });

        let followUpFirstToken = false;
        for await (const fchunk of followUp) {
          const fdelta = fchunk.choices[0]?.delta?.content;
          if (fdelta) {
            if (!followUpFirstToken) {
              followUpFirstToken = true;
              mark("llm_first_token_after_tool");
            }
            full += fdelta;
            sse(res, "token", { text: fdelta });
          }
        }
      }
    }

    mark("llm_done");
    sse(res, "done", { text: full });
    res.end();

    // Fire-and-forget: never block the response on persistence.
    Promise.all([
      appendMessage(userId, "user", message),
      appendMessage(userId, "assistant", full),
    ]).catch((err) => console.error("[sarjy] message log failed:", err));

    extractFacts(message, full).then((updates) => setFacts(userId, updates));
  } catch (err) {
    console.error("[sarjy] chat failed:", err);
    sse(res, "error", { message: err.message });
    res.end();
  }
});
