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
 * - `speaking`: one or more sentences are queued/playing via `speechSynthesis`.
 */

/**
 * @typedef {Object} ChatMessage
 * @property {"user" | "assistant"} role Who authored the message.
 * @property {string} content Message text. For the in-flight assistant message
 *   this grows token by token while streaming.
 */

/**
 * @typedef {Object} TurnTimings
 * Milliseconds SINCE THE SERVER RECEIVED THE REQUEST, keyed by checkpoint
 * name — these come straight from the server's `timing` SSE events
 * (`{ name, ms }`) and are not compared against the client's own clock, to
 * avoid cross-machine clock-skew error. Available keys depend on whether a
 * tool call happened this turn (see chat.js).
 * @property {number} [key] e.g. memory_loaded, llm_first_token, tool_result,
 *   llm_first_token_after_tool, llm_done.
 */

/**
 * @typedef {Object} UseVoiceChatResult
 * @property {VoiceState} state Current phase of the voice turn.
 * @property {ChatMessage[]} messages Conversation history, oldest first.
 * @property {string | null} errorText User-facing error message, or `null`.
 *   Cleared when listening starts.
 * @property {TurnTimings | null} timings Server-reported latency checkpoints
 *   for the latest turn, relative to that request's start.
 * @property {number | null} ttfa Time-to-first-audible-word for the latest
 *   turn, in ms, measured client-side from mic-release to the first spoken
 *   utterance actually starting. This is the headline "did it feel fast"
 *   number — it accounts for STT + chat + speech synthesis start, not just
 *   the LLM's first token.
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
 * 3. **Think + Speak**: POSTs the text to `/api/chat` and reads a
 *    Server-Sent Events stream (`token`, `timing`, `error` events). As soon
 *    as a complete sentence has streamed in, it's queued to
 *    `speechSynthesis` immediately — we don't wait for the full reply
 *    before speaking starts, which is the main lever for perceived latency
 *    now that TTS is local instead of a network call.
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
  /** @type {[number | null, Function]} */
  const [ttfa, setTtfa] = useState(null);

  /** @type {React.MutableRefObject<MediaRecorder | null>} Active recorder. */
  const mediaRecorderRef = useRef(null);
  /** @type {React.MutableRefObject<Blob[]>} Audio chunks for the current recording. */
  const chunksRef = useRef([]);
  /** @type {React.MutableRefObject<string>} Stable anonymous user id. */
  const userId = useRef(getUserId());
  /** @type {React.MutableRefObject<number>} performance.now() when the mic
   *  was released for the in-flight turn — the start point for TTFA. */
  const recordingStoppedAt = useRef(0);

  /**
   * Speaks one sentence via the browser's `speechSynthesis`. Calling this
   * repeatedly queues utterances in order — `speechSynthesis` plays them
   * back to back, so sentences can be handed off as they stream in rather
   * than waiting for the whole reply.
   *
   * The FIRST utterance of a turn marks `ttfa` on its `onstart` event (the
   * moment sound actually begins), and `state` returns to `idle` once the
   * LAST queued utterance for the turn finishes.
   *
   * @param {string} text Sentence to speak.
   * @param {{ isFirst: boolean }} flags Whether this is the turn's first utterance.
   * @param {React.MutableRefObject<number>} pendingRef Count of utterances
   *   still queued/playing for this turn, shared across calls.
   */
  const speakSentence = useCallback((text, flags, pendingRef) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const utter = new SpeechSynthesisUtterance(trimmed);
    pendingRef.current += 1;

    if (flags.isFirst) {
      flags.isFirst = false;
      utter.onstart = () => {
        setState("speaking");
        setTtfa(performance.now() - recordingStoppedAt.current);
      };
    }

    const onSettled = () => {
      pendingRef.current -= 1;
      if (pendingRef.current <= 0) setState("idle");
    };
    utter.onend = onSettled;
    utter.onerror = onSettled;

    window.speechSynthesis.speak(utter);
  }, []);

  /**
   * Sends user text to `/api/chat` and streams the reply. As sentence
   * boundaries appear in the streamed text, each sentence is immediately
   * queued to speech via {@link speakSentence} instead of waiting for the
   * full reply to finish — this is what makes the assistant start talking
   * mid-generation rather than after a full pause.
   *
   * SSE events handled:
   * - `timing`: `{ name: string, ms: number }` — server-relative duration,
   *   merged into `timings` as-is (see the {@link TurnTimings} typedef for
   *   why this isn't compared against a client timestamp).
   * - `token`: `{ text: string }`, appended to the assistant message and to
   *   the sentence buffer.
   * - `error`: `{ message: string }`, surfaced via `errorText`.
   *
   * Sentence splitting is a simple trailing-punctuation check (`.`, `!`,
   * `?`). It'll occasionally split early on abbreviations or decimals
   * ("Dr.", "3.5") — an acceptable trade-off for a take-home; a sentence
   * tokenizer would be the fix with more time.
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
      setTtfa(null);
      const localTimings = {};

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
      let sentenceBuffer = "";

      const speakFlags = { isFirst: true };
      const pendingUtterances = { current: 0 };

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
            localTimings[data.name] = data.ms;
            setTimings({ ...localTimings });
          } else if (event === "token") {
            full += data.text;
            sentenceBuffer += data.text;
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { role: "assistant", content: full };
              return copy;
            });

            if (/[.!?]$/.test(sentenceBuffer.trim())) {
              speakSentence(sentenceBuffer, speakFlags, pendingUtterances);
              sentenceBuffer = "";
            }
          } else if (event === "error") {
            setErrorText(data.message);
          }
        }
      }

      if (sentenceBuffer.trim()) {
        speakSentence(sentenceBuffer, speakFlags, pendingUtterances);
      } else if (pendingUtterances.current === 0) {
        // Nothing was ever queued (empty/failed reply) — don't get stuck in "thinking".
        setState("idle");
      }
    },
    [speakSentence]
  );

  /**
   * Requests microphone access and starts recording. On stop, uploads the audio
   * to `/api/transcribe` and forwards the transcript to {@link sendToChat}.
   *
   * Records `recordingStoppedAt` the moment the mic is released — this is
   * the reference point `ttfa` is measured from, so it has to be captured
   * here rather than later in the pipeline.
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
        recordingStoppedAt.current = performance.now();
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
   * NOTE: `ttfa` will measure from "now" rather than from a mic release,
   * since there's no recording step in this path — treat ttfa as
   * voice-turn-only data when analyzing it.
   *
   * @param {string} text The message to send.
   * @returns {void}
   */
  const sendTextFallback = useCallback(
    (text) => {
      recordingStoppedAt.current = performance.now();
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
    ttfa,
    startListening,
    stopListening,
    sendTextFallback,
    forgetMe,
  };
}