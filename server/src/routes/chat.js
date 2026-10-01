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
  if (!userId) return res.status(400).json({ error: "Missing x-user-id header" });
  if (!message) return res.status(400).json({ error: "Missing message" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const timings = { received: Date.now() };
  const mark = (name) => {
    timings[name] = Date.now();
    sse(res, "timing", { name, at: timings[name] });
  };

  try {
    const facts = getFacts(userId);
    const history = getRecentMessages(userId).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const messages = [
      { role: "system", content: buildSystemPrompt(facts) },
      ...history,
      { role: "user", content: message },
    ];

    // --- First pass: let the model decide if it needs the weather tool ---
    // (Not streamed — a tool-calling turn can't stream partial tool_calls
    // usefully. This is the extra hop the latency deep dive should target:
    // see TDD §13.4 on speculative/parallel tool execution.)
    const first = await groq.chat.completions.create({
      model: MODELS.chat,
      messages,
      tools: [weatherToolDefinition],
      tool_choice: "auto",
    });
    mark("llm_decision");

    const choice = first.choices[0];
    const toolCalls = choice.message.tool_calls;
    let finalMessages = messages;

    if (toolCalls && toolCalls.length > 0) {
      finalMessages = [...messages, choice.message];
      for (const call of toolCalls) {
        if (call.function.name === "get_weather") {
          const args = JSON.parse(call.function.arguments || "{}");
          const result = await getWeather(args.location);
          mark("tool_result");
          finalMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }
    }

    // --- Second pass: stream the actual spoken reply ---
    const stream = await groq.chat.completions.create({
      model: MODELS.chat,
      messages: finalMessages,
      stream: true,
    });

    let full = "";
    let firstToken = false;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (delta && !firstToken) {
        firstToken = true;
        mark("llm_first_token");
      }
      if (delta) {
        full += delta;
        sse(res, "token", { text: delta });
      }
    }
    mark("llm_done");

    appendMessage(userId, "user", message);
    appendMessage(userId, "assistant", full);

    sse(res, "done", { text: full, timings });
    res.end();

    // Fire-and-forget: don't hold up the response for fact extraction.
    extractFacts(message, full).then((facts) => setFacts(userId, facts));
  } catch (err) {
    console.error("[sarjy] chat failed:", err);
    sse(res, "error", { message: err.message });
    res.end();
  }
});
