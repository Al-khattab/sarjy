import { useCallback, useRef, useState } from "react";

/**
 * Returns a stable, anonymous per-browser user id, creating and persisting one
 * in `localStorage` on first use. Sent to the backend as the `x-user-id` header
 * so the server can associate memory with this browser.
 *
 * @returns {string} A UUID v4 string.
 * @throws {DOMException} If `localStorage` is unavailable (e.g. blocked in private mode).
 */
function getUserId() {
  let id = localStorage.getItem("sarjy_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sarjy_user_id", id);
  }
  return id;
}

/**
 * @typedef {"idle" | "listening" | "transcribing" | "thinking" | "speaking"} VoiceState
 * Current phase of the voice turn.
 * - `idle`: waiting for the user.
 * - `listening`: microphone is recording.
 * - `transcribing`: audio is being sent to `/api/transcribe`.
 * - `thinking`: waiting for / streaming the LLM reply from `/api/chat`.
 * - `speaking`: reply is being played via `/api/speak` (or browser TTS fallback).
 */

/**
 * @typedef {Object} ChatMessage
 * @property {"user" | "assistant"} role Who authored the message.
 * @property {string} content Message text. For the in-flight assistant message
 *   this grows token by token while streaming.
 */

/**
 * @typedef {Object} TurnTimings
 * Milliseconds since the epoch, keyed by checkpoint name.
 * `turn_start` is set client-side; other keys come from server `timing` SSE
 * events (`{ name, at }`), so the available keys depend on the backend.
 * @property {number} turn_start Client timestamp (`Date.now()`) when the turn began.
 * @property {number} [key] Additional server-provided checkpoints.
 */

/**
 * @typedef {Object} UseVoiceChatResult
 * @property {VoiceState} state Current phase of the voice turn.
 * @property {ChatMessage[]} messages Conversation history, oldest first.
 * @property {string | null} errorText User-facing error message, or `null`.
 *   Cleared when listening starts.
 * @property {TurnTimings | null} timings Latency checkpoints for the latest turn.
 * @property {() => Promise<void>} startListening Requests the mic and begins recording.
 * @property {() => void} stopListening Stops recording, which triggers transcription
 *   and the rest of the turn.
 * @property {(text: string) => void} sendTextFallback Sends typed text through the
 *   same chat -> speak pipeline, bypassing the microphone.
 * @property {() => Promise<void>} forgetMe Asks the server to delete this user's
 *   stored data and clears local messages.
 */

/**
 * React hook that drives a push-to-talk voice assistant.
 *
 * Turn pipeline:
 * `idle -> listening -> transcribing -> thinking -> speaking -> idle`
 *
 * 1. **Listen**: records mic audio with `MediaRecorder`.
 * 2. **Transcribe**: POSTs the audio to `/api/transcribe` (expects `{ text }`).
 * 3. **Think**: POSTs the text to `/api/chat` and reads a Server-Sent Events
 *    stream (`token`, `timing`, `error` events), updating the last assistant
 *    message live.
 * 4. **Speak**: POSTs the full reply to `/api/speak` and plays the returned
 *    audio, falling back to the browser's `speechSynthesis` on failure.
 *
 * Errors surface through `errorText` and return the state to `idle`, so the
 * next mic press always starts a fresh turn.
 *
 * @example
 * function VoiceButton() {
 *   const { state, messages, errorText, startListening, stopListening } = useVoiceChat();
 *   return (
 *     <button
 *       onMouseDown={startListening}
 *       onMouseUp={stopListening}
 *       disabled={state !== "idle" && state !== "listening"}
 *     >
 *       {state}
 *     </button>
 *   );
 * }
 *
 * @returns {UseVoiceChatResult} State and actions for the voice chat UI.
 */
export function useVoiceChat() {
  /** @type {[VoiceState, Function]} */
  const [state, setState] = useState("idle");
  /** @type {[ChatMessage[], Function]} */
  const [messages, setMessages] = useState([]);
  /** @type {[string | null, Function]} */
  const [errorText, setErrorText] = useState(null);
  /** @type {[TurnTimings | null, Function]} */
  const [timings, setTimings] = useState(null);

  /** @type {React.MutableRefObject<MediaRecorder | null>} Active recorder. */
  const mediaRecorderRef = useRef(null);
  /** @type {React.MutableRefObject<Blob[]>} Audio chunks for the current recording. */
  const chunksRef = useRef([]);
  /** @type {React.MutableRefObject<HTMLAudioElement | null>} Currently playing TTS audio. */
  const audioElRef = useRef(null);
  /** @type {React.MutableRefObject<string>} Stable anonymous user id. */
  const userId = useRef(getUserId());

  /**
   * Speaks `text` aloud. Tries server TTS (`/api/speak`) first and falls back
   * to `speechSynthesis` if the request or decoding throws. Resolves when
   * playback ends (or fails) and always resets state to `idle`.
   *
   * NOTE: the object URL is never revoked, so each reply leaks a small blob
   * until the page unloads.
   *
   * @param {string} text Text to synthesize.
   * @returns {Promise<void>}
   */
  const speak = useCallback(async (text) => {
    setState("speaking");
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS request failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioElRef.current = audio;
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
    } catch {
      // Fallback: browser TTS, so the loop still completes even if the
      // Groq TTS call fails
      await new Promise((resolve) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.onend = resolve;
        utter.onerror = resolve;
        window.speechSynthesis.speak(utter);
      });
    } finally {
      setState("idle");
    }
  }, []);

  /**
   * Sends user text to `/api/chat`, streams the reply into `messages`, then
   * calls {@link speak} with the complete reply.
   *
   * Appends the user message and an empty assistant placeholder immediately,
   * then fills the placeholder as `token` events arrive. SSE events handled:
   * - `timing`: `{ name: string, at: number }`, merged into `timings`.
   * - `token`: `{ text: string }`, appended to the assistant message.
   * - `error`: `{ message: string }`, surfaced via `errorText`.
   *
   * On a non-OK response, sets `errorText` and returns to `idle`.
   *
   * @param {string} userText The user's transcribed or typed message.
   * @returns {Promise<void>}
   */
  const sendToChat = useCallback(
    async (userText) => {
      setState("thinking");
      setMessages((m) => [...m, { role: "user", content: userText }]);
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const localTimings = { turn_start: Date.now() };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId.current,
        },
        body: JSON.stringify({ message: userText }),
      });

      if (!res.ok || !res.body) {
        setErrorText("Sarjy couldn't respond just now. Try again?");
        setState("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

      // Minimal hand-rolled SSE parser — EventSource can't be used because
      // it only supports GET requests, and we need to send a POST body.
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; keep the trailing partial frame.
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const raw of events) {
          const lines = raw.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());

          if (event === "timing") {
            localTimings[data.name] = data.at;
            setTimings({ ...localTimings });
          } else if (event === "token") {
            full += data.text;
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { role: "assistant", content: full };
              return copy;
            });
          } else if (event === "error") {
            setErrorText(data.message);
          }
        }
      }

      await speak(full);
    },
    [speak]
  );

  /**
   * Requests microphone access and starts recording. On stop, uploads the audio
   * to `/api/transcribe` and forwards the transcript to {@link sendToChat}.
   *
   * Failure handling (all set `errorText` and return to `idle`):
   * - mic permission denied / unavailable
   * - empty or failed transcription
   * - network error during transcription
   *
   * @returns {Promise<void>}
   */
  const startListening = useCallback(async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        // Release the mic so the browser's recording indicator turns off.
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", blob, "audio.webm");

        try {
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok || !data.text) {
            setErrorText("Didn't catch that — mind trying again?");
            setState("idle");
            return;
          }
          await sendToChat(data.text);
        } catch {
          setErrorText("Transcription failed — check your connection.");
          setState("idle");
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setState("listening");
    } catch {
      setErrorText("Microphone access was denied. You can type instead below.");
      setState("idle");
    }
  }, [sendToChat]);

  /**
   * Stops the active recording, which fires the recorder's `onstop` handler and
   * begins transcription. No-op if nothing is recording.
   *
   * @returns {void}
   */
  const stopListening = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  /**
   * Text-input alternative to the mic (e.g. when permission is denied or in
   * noisy environments). Runs the same chat -> speak pipeline.
   *
   * @param {string} text The message to send.
   * @returns {void}
   */
  const sendTextFallback = useCallback(
    (text) => {
      sendToChat(text);
    },
    [sendToChat]
  );

  /**
   * Requests server-side deletion of this user's stored data and clears the
   * local conversation. Local messages are cleared even if the server
   * responds with an error, since the response status is not checked.
   *
   * @returns {Promise<void>}
   */
  const forgetMe = useCallback(async () => {
    await fetch("/api/forget-me", {
      method: "POST",
      headers: { "x-user-id": userId.current },
    });
    setMessages([]);
  }, []);

  return {
    state,
    messages,
    errorText,
    timings,
    startListening,
    stopListening,
    sendTextFallback,
    forgetMe,
  };
}