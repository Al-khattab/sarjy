import { Router } from "express";
import multer from "multer";
import { groq, MODELS } from "../groq.js";
import { evaluateTranscription } from "../transcriptionFilter.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
export const transcribeRouter = Router();

// STT_FORCE_ENGLISH=true passes language:"en" to Whisper. That stops the
// language misdetection that produces foreign-language output on short or
// noisy clips, but non-English speech then comes back as English-looking
// junk instead of being detected and rejected. The default (false) detects
// the language and rejects anything that isn't English; try the other mode
// if you see English speech being rejected as "non_english".
const FORCE_ENGLISH = process.env.STT_FORCE_ENGLISH === "true";
// DEBUG_STT=true logs the raw Whisper response, useful for confirming the
// field names (language, segments[].no_speech_prob, ...) the filter relies on.
const DEBUG_STT = process.env.DEBUG_STT === "true";

// Client posts the recorded audio blob as multipart/form-data field "audio".
//
// Responds 200 with { text, unintelligible }. When Whisper's output isn't
// usable English speech, text is "" and unintelligible is true, so the
// client can ask the user to repeat instead of sending garbage to the LLM.
transcribeRouter.post("/", upload.single("audio"), async (req, res) => {
  const t0 = Date.now();
  if (!req.file) {
    return res.status(400).json({ error: "Missing audio file" });
  }

  try {
    const result = await groq.audio.transcriptions.create({
      file: new File([req.file.buffer], "audio.webm", {
        type: req.file.mimetype || "audio/webm",
      }),
      model: MODELS.whisper,
      response_format: "verbose_json", // needed for language + confidence data
      temperature: 0,
      ...(FORCE_ENGLISH ? { language: "en" } : {}),
    });

    if (DEBUG_STT)
      console.log("[sarjy] raw STT:", JSON.stringify(result).slice(0, 1200));

    const verdict = evaluateTranscription(result, {
      requireEnglish: !FORCE_ENGLISH,
    });
    const ms = Date.now() - t0;

    if (!verdict.ok) {
      console.info(
        `[sarjy] STT rejected (${verdict.reason}): ${verdict.detail ?? ""}`
      );
      return res.json({
        text: "",
        unintelligible: true,
        reason: verdict.reason,
        ms,
      });
    }

    res.json({ text: verdict.text, unintelligible: false, ms });
  } catch (err) {
    console.error("[sarjy] transcription failed:", err);
    res
      .status(502)
      .json({ error: "Transcription failed", detail: err.message });
  }
});
