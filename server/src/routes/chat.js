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
  // Writing to a response the client already closed is wasted work (and can
  // surface as stream errors), so drop it.
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

chatRouter.post("/", async (req, res) => {
  const userId = req.header("x-user-id");
  const { message } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing x-user-id header" });
  if (!message) return res.status(400).json({ error: "Missing message" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // If the client disconnects before we've finished writing the response
  // (the user cancelled, or forgot-me was pressed mid-reply), stop doing
  // work for it: abort the upstream Groq stream, skip the weather call, and
  // above all don't persist the half-finished exchange to memory.
  //
  // This listens on `res`, not `req`: since Node 16 a request's 'close'
  // event fires once its body has been read, not when the client leaves.
  const upstream = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      clientGone = true;
      upstream.abort();
    }
  });

  const t0 = Date.now();
  // Relative to request start, not absolute, to avoid comparing the
  // server's clock against the client's across the network.
  const mark = (name) => sse(res, "timing", { name, ms: Date.now() - t0 });

  try {
    // Both memory reads run concurrently: one fewer Neon round trip per turn.
    const [facts, recent] = await Promise.all([
      getFacts(userId),
      getRecentMessages(userId),
    ]);
    mark("memory_loaded");
    if (clientGone) return;

    const history = recent.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const messages = [
      { role: "system", content: buildSystemPrompt(facts) },
      ...history,
      { role: "user", content: message },
    ];

    // Single streamed call from the start. Most turns never need the weather
    // tool, so this is the ONLY Groq round trip for the common case.
    const stream = await groq.chat.completions.create(
      {
        model: MODELS.chat,
        messages,
        tools: [weatherToolDefinition],
        tool_choice: "auto",
        stream: true,
      },
      { signal: upstream.signal }
    );

    let full = "";
    let firstToken = false;
    let toolCall = null; // { id, name, args }, accumulated across chunks

    for await (const chunk of stream) {
      if (clientGone) break;
      const delta = chunk.choices[0]?.delta;
      const finishReason = chunk.choices[0]?.finish_reason;

      if (delta?.tool_calls) {
        // Assumes a single tool call per turn (we only expose one tool).
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
        if (clientGone) break; // don't spend a weather API call on a cancelled turn
        const args = JSON.parse(toolCall.args || "{}");
        const result = await getWeather(args.location);
        mark("tool_result");
        if (clientGone) break;

        // Second call only happens when a tool was actually invoked.
        const followUp = await groq.chat.completions.create(
          {
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
          },
          { signal: upstream.signal }
        );

        let followUpFirstToken = false;
        for await (const fchunk of followUp) {
          if (clientGone) break;
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

    // A cancelled turn never completed from the user's point of view, so it
    // must not be saved (it would otherwise be remembered and could even
    // resurrect memory the user just asked to forget).
    if (clientGone) return;

    mark("llm_done");
    sse(res, "done", { text: full });
    res.end();

    // Fire-and-forget: never block the response on persistence.
    if (full.trim()) {
      Promise.all([
        appendMessage(userId, "user", message),
        appendMessage(userId, "assistant", full),
      ]).catch((err) => console.error("[sarjy] message log failed:", err));

      extractFacts(message, full).then((updates) => setFacts(userId, updates));
    }
  } catch (err) {
    // An abort we caused surfaces here as an error; that's expected, not a failure.
    if (clientGone) return;
    console.error("[sarjy] chat failed:", err);
    sse(res, "error", { message: err.message });
    res.end();
  }
});
