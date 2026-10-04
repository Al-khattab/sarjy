import { Router } from "express";
import { groq, MODELS } from "../groq.js";

export const speakRouter = Router();

// Text -> speech. Returns raw audio bytes; the client plays them directly.
speakRouter.post("/", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });

  const t0 = Date.now();
  try {
    const response = await groq.audio.speech.create({
      model: MODELS.tts,
      voice: MODELS.ttsVoice,
      input: text,
      response_format: "wav",
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    // Exposes pure synthesis time to the client separately from total
    // round-trip time, so you can tell network overhead apart from Groq's
    // own processing time when comparing against the browser's local TTS.
    res.setHeader("X-Synthesis-Ms", Date.now() - t0);
    res.setHeader("Access-Control-Expose-Headers", "X-Synthesis-Ms");
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err) {
    // Log the full error, not just .message — if this breaks again, you
    // want the actual cause (auth, model name, rate limit) visible in
    // Render's logs rather than a vague one-liner, same lesson as weather.js.
    console.error("[sarjy] TTS failed:", err);
    res.status(502).json({ error: "TTS failed", detail: err.message });
  }
});