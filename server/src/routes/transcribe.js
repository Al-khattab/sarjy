import { Router } from "express";
import multer from "multer";
import { groq, MODELS } from "../groq.js";

const upload = multer({ storage: multer.memoryStorage() });
export const transcribeRouter = Router();

// Client posts the recorded audio blob as multipart/form-data field "audio".
transcribeRouter.post("/", upload.single("audio"), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) {
    return res.status(400).json({ error: "Missing audio file" });
  }

  try {
    const transcription = await groq.audio.transcriptions.create({
      file: new File([req.file.buffer], "audio.webm", {
        type: req.file.mimetype || "audio/webm",
      }),
      model: MODELS.whisper,
    });

    res.json({
      text: transcription.text,
      ms: Date.now() - t0,
    });
  } catch (err) {
    console.error("[sarjy] transcription failed:", err);
    res.status(502).json({ error: "Transcription failed", detail: err.message });
  }
});
