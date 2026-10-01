import Groq from "groq-sdk";

if (!process.env.GROQ_API_KEY) {
  console.warn(
    "[sarjy] GROQ_API_KEY is not set — /api/transcribe, /api/chat and " +
      "/api/speak will fail until you add it to server/.env"
  );
}

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export const MODELS = {
  chat: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
  whisper: process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo",
  tts: process.env.GROQ_TTS_MODEL || "playai-tts",
  ttsVoice: process.env.GROQ_TTS_VOICE || "Fritz-PlayAI",
};
