import { Router } from "express";
import { groq, MODELS } from "../groq.js";

export const speakRouter = Router();

// Text -> speech. Returns raw audio bytes; the client plays them directly.
// If this fails for any reason (bad key, model name changed upstream, rate
// limit) the client falls back to the browser's SpeechSynthesis API rather
// than breaking the turn — see client/src/hooks/useVoiceChat.js.
speakRouter.post("/", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });

  try {
    const response = await groq.audio.speech.create({
      model: MODELS.tts,
      voice: MODELS.ttsVoice,
      input: text,
      response_format: "wav",
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/wav");
    res.send(buffer);
  } catch (err) {
    console.error("[sarjy] TTS failed:", err.message);
    res.status(502).json({ error: "TTS failed", detail: err.message });
  }
});
