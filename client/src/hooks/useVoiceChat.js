import { useCallback, useEffect, useRef, useState } from "react";
import { createVad } from "../lib/vad.js";

/**
 * Returns a stable, anonymous per-browser user id, creating and persisting one
 * in `localStorage` on first use. Sent to the backend as the `x-user-id` header
 * so the server can associate memory with this browser.
 *
 * @returns {string} A UUID v4 string.
 */
function getUserId() {
  let id = localStorage.getItem("sarjy_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sarjy_user_id", id);
  }
  return id;
}

// --- Tunables ---------------------------------------------------------
// Set true to log live mic levels, the noise floor and both thresholds a few
// times a second. Open the console, stay quiet, then talk normally, and you
// can see exactly where your room and mic sit. The VAD thresholds themselves
// live in lib/vad.js.
const VAD_DEBUG = false;

const MAX_RECORDING_MS = 20000; // hard cap if silence is never detected
const RELISTEN_DELAY_MS = 400; // gap after Sarjy stops talking before the mic reopens
const MAX_FAILURE_STREAK = 3; // consecutive failed turns before hands-free pauses itself

// Mic processing. Echo cancellation stays on so Sarjy doesn't hear herself
// through the speakers. Auto gain is OFF: it boosts the noise floor during
// quiet moments, which makes the VAD think someone is talking and makes the
// level readings unstable. Noise suppression is OFF too: its artifacts can
// hurt transcription accuracy more than steady background noise does. If a
// fan or traffic hum is a problem in your room, flip noiseSuppression to true
// and compare. Change one setting at a time.
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: false,
  autoGainControl: false,
};

const REPEAT_PROMPT = "Sorry, I didn't catch that. Could you say it again in English?";
const GIVE_UP_PROMPT =
  "I'm having trouble hearing you. Tap the button when you're ready to try again.";

/**
 * @typedef {"idle" | "listening" | "transcribing" | "thinking" | "speaking"} VoiceState
 */

/**
 * @typedef {"browser" | "groq"} TtsProvider
 * - `browser`: Web Speech API; synthesis is local, zero network cost.
 * - `groq`: `/api/speak`; a network + inference round trip per sentence.
 */

/**
 * @typedef {Object} ChatMessage
 * @property {"user" | "assistant"} role
 * @property {string} content Grows token by token for the in-flight reply.
 */

/**
 * @typedef {Object} TurnTimings
 * Milliseconds since the server received the request, keyed by checkpoint
 * (memory_loaded, llm_first_token, tool_call_detected, tool_result,
 * llm_first_token_after_tool, llm_done).
 */

/**
 * @typedef {Object} TtsDebug
 * @property {TtsProvider} provider
 * @property {number} roundTripMs Client-measured fetch-to-first-audio; 0 for browser.
 * @property {number | null} synthesisMs Server-reported synthesis time; null for browser.
 */

/**
 * @typedef {Object} Turn
 * Bookkeeping for one assistant reply being spoken. A turn is only finished
 * when the LLM stream has ended AND every queued sentence has been spoken.
 * Checking only the second condition made the mic reopen mid-reply whenever
 * speech got ahead of the LLM.
 * @property {number} id Cancellation epoch this turn belongs to.
 * @property {boolean} firstAudioMarked True once the first sentence has been queued, so TTFA is only recorded once.
 * @property {number} pending Sentences queued or playing.
 * @property {boolean} streamDone True once the LLM stream has ended.
 * @property {boolean} finished Guards against finishing twice.
 */

/**
 * React hook for a push-to-talk or hands-free voice assistant.
 *
 * Turn pipeline:
 * `listening (VAD) -> transcribing -> thinking -> speaking -> (hands-free) listening ...`
 *
 * Cancellation model. Every async step of a turn (transcribe fetch, chat
 * stream, TTS fetch, queued speech, the delayed re-listen) can outlive the
 * moment the user cancels or presses Forget me. Without care they all carry
 * on and produce an extra reply. So:
 * - `turnIdRef` is an epoch. `interruptCurrentTurn()` bumps it, and every
 *   continuation compares the epoch it started under to the current one and
 *   quietly stops if they differ.
 * - `turnAbortRef` holds an AbortController for the turn's fetches.
 *   Aborting also closes the chat stream, which tells the server to stop
 *   generating and to skip saving the exchange.
 *
 * Audio only reaches Whisper if the VAD confirmed real speech (or the user
 * stopped it manually). Silence and noise are dropped locally. Whatever does
 * get through is filtered server-side; if it isn't clear English, the
 * server answers `unintelligible` and Sarjy asks the user to repeat.
 *
 * @returns {{
 *   state: VoiceState, handsFree: boolean, messages: ChatMessage[],
 *   errorText: string | null, timings: TurnTimings | null, ttfa: number | null,
 *   ttsProvider: TtsProvider, setTtsProvider: (p: TtsProvider) => void,
 *   ttsDebug: TtsDebug | null,
 *   startListening: () => Promise<void>, stopListening: () => void,
 *   startConversation: () => Promise<void>, endConversation: () => void,
 *   sendTextFallback: (text: string) => void, forgetMe: () => Promise<void>,
 * }}
 */
export function useVoiceChat() {
  const [state, setState] = useState("idle");
  const [handsFree, setHandsFree] = useState(false);
  const [messages, setMessages] = useState([]);
  const [errorText, setErrorText] = useState(null);
  const [timings, setTimings] = useState(null);
  const [ttfa, setTtfa] = useState(null);
  const [ttsProvider, setTtsProvider] = useState("browser");
  const [ttsDebug, setTtsDebug] = useState(null);

  const userId = useRef(getUserId());
  const recordingStoppedAt = useRef(0);

  // The ref is the source of truth; the state only drives the UI. Updating
  // both together avoids a window where a timer reads a stale `true` right
  // after the user ended the conversation.
  const handsFreeRef = useRef(false);
  const updateHandsFree = useCallback((value) => {
    handsFreeRef.current = value;
    setHandsFree(value);
  }, []);

  const ttsProviderRef = useRef(ttsProvider);
  useEffect(() => {
    ttsProviderRef.current = ttsProvider;
  }, [ttsProvider]);

  // --- cancellation ---
  const turnIdRef = useRef(0);
  const turnAbortRef = useRef(null);
  const failureStreakRef = useRef(0);

  // --- recording / VAD ---
  const mediaRecorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const stopReasonRef = useRef("manual");
  const startingRef = useRef(false);
  const audioCtxRef = useRef(null);
  const vadRef = useRef(null);
  const noiseFloorRef = useRef(null); // carried between turns, skips recalibration
  const vadRafRef = useRef(null);
  const vadTimeoutRef = useRef(null);

  // --- playback ---
  const groqQueueRef = useRef([]);
  const groqPlayingRef = useRef(false);
  const currentGroqAudioRef = useRef(null);
  const groqSettleRef = useRef(null);
  const startListeningRef = useRef(null); // breaks the continueIfHandsFree <-> startListening cycle

  /** Starts a new turn: fresh AbortController, current epoch. */
  const beginTurn = useCallback(() => {
    turnAbortRef.current = new AbortController();
    return turnIdRef.current;
  }, []);

  /**
   * Stops the recorder exactly once, however it was triggered. Calling
   * `.stop()` on an inactive recorder throws, so every path goes through here.
   * @param {"silence" | "timeout" | "manual"} [reason]
   */
  const safeStopRecorder = useCallback((reason = "manual") => {
    if (mediaRecorderRef.current?.state === "recording") {
      stopReasonRef.current = reason;
      mediaRecorderRef.current.stop();
    }
  }, []);

  /** Tears down the VAD loop and AudioContext, remembering the noise floor. */
  const stopVad = useCallback(() => {
    if (vadRafRef.current) cancelAnimationFrame(vadRafRef.current);
    vadRafRef.current = null;
    if (vadTimeoutRef.current) clearTimeout(vadTimeoutRef.current);
    vadTimeoutRef.current = null;
    if (vadRef.current) {
      noiseFloorRef.current = vadRef.current.getNoiseFloor() ?? noiseFloorRef.current;
      vadRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  /**
   * Immediately stops everything belonging to the current turn and forces
   * state to "idle": bumps the epoch (making every in-flight continuation
   * stale), aborts its fetches, silences speech, and closes the mic.
   *
   * State is forced directly instead of waiting for completion callbacks:
   * speechSynthesis.cancel() only fires onend/onerror for the sentence that
   * was actually speaking, not for ones queued behind it, so those callbacks
   * can't be relied on to bring state back to idle.
   */
  const interruptCurrentTurn = useCallback(() => {
    turnIdRef.current += 1;
    turnAbortRef.current?.abort();
    window.speechSynthesis.cancel();
    if (currentGroqAudioRef.current) {
      currentGroqAudioRef.current.pause();
      currentGroqAudioRef.current = null;
    }
    groqSettleRef.current?.(); // unblocks a drain loop awaiting playback
    groqSettleRef.current = null;
    groqQueueRef.current = [];
    groqPlayingRef.current = false;
    safeStopRecorder(); // its onstop sees the stale epoch and discards the audio
    stopVad();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    setState("idle");
  }, [safeStopRecorder, stopVad]);

  /**
   * Feeds mic levels to the VAD every animation frame, and stops the
   * recorder once it reports a confirmed utterance followed by silence.
   * A separate timeout caps the recording if silence is never detected.
   * @param {MediaStream} stream
   */
  const startVad = useCallback(
    (stream) => {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCtor();
      // A context created outside a user gesture can start suspended
      // (this is how auto re-listens begin).
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser); // deliberately not connected to the output
      audioCtxRef.current = audioCtx;

      const vad = createVad({ initialNoiseFloor: noiseFloorRef.current });
      vadRef.current = vad;

      // Float samples, not getByteTimeDomainData: 8-bit samples are
      // quantized to steps of ~0.008, coarse enough to make quiet-room
      // readings jump around.
      const samples = new Float32Array(analyser.fftSize);
      let lastLogAt = 0;

      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
        const rms = Math.sqrt(sumSquares / samples.length);
        const now = performance.now();

        const r = vad.update(rms, now);

        if (VAD_DEBUG && now - lastLogAt > 250) {
          lastLogAt = now;
          console.log(
            `[vad] ${r.phase.padEnd(7)} rms=${r.rms.toFixed(4)} ` +
              `floor=${r.noiseFloor?.toFixed(4) ?? "calibrating"} ` +
              `speech>${r.speechThreshold.toFixed(4)} quiet<${r.silenceThreshold.toFixed(4)} ` +
              `heardSpeech=${vad.hasSpeech}`
          );
        }

        if (r.stop) {
          safeStopRecorder("silence");
          return;
        }
        vadRafRef.current = requestAnimationFrame(tick);
      };

      vadRafRef.current = requestAnimationFrame(tick);
      vadTimeoutRef.current = setTimeout(() => safeStopRecorder("timeout"), MAX_RECORDING_MS);
    },
    [safeStopRecorder]
  );

  /**
   * If hands-free is active, reopens the mic after a short gap (letting
   * speaker audio decay). Called only from real "turn complete" points.
   * Captures the epoch so a conversation ended during the gap doesn't get
   * restarted by a timer that was already pending.
   */
  const continueIfHandsFree = useCallback(() => {
    if (!handsFreeRef.current) return;
    const scheduledFor = turnIdRef.current;
    setTimeout(() => {
      if (handsFreeRef.current && scheduledFor === turnIdRef.current) {
        startListeningRef.current?.();
      }
    }, RELISTEN_DELAY_MS);
  }, []);

  /**
   * Marks a turn done once the LLM stream has ended and nothing is left to
   * say, then returns to idle and (in hands-free) listens again.
   * @param {Turn} turn
   */
  const maybeFinishTurn = useCallback(
    (turn) => {
      if (turn.id !== turnIdRef.current || turn.finished) return;
      if (turn.streamDone && turn.pending <= 0) {
        turn.finished = true;
        setState("idle");
        continueIfHandsFree();
      }
    },
    [continueIfHandsFree]
  );

  /**
   * Plays queued sentences through /api/speak (Groq TTS) one at a time, in
   * order. Unlike speechSynthesis, <audio> has no built-in queue.
   * @param {Turn} turn
   */
  const drainGroqQueue = useCallback(
    async (turn) => {
      if (groqPlayingRef.current) return;
      const text = groqQueueRef.current.shift();
      if (!text) return;
      groqPlayingRef.current = true;

      const fetchStart = performance.now();
      let interrupted = false;
      try {
        const res = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: turnAbortRef.current?.signal,
        });
        if (!res.ok) throw new Error("TTS request failed");
        const synthesisMs = res.headers.get("X-Synthesis-Ms");
        const blob = await res.blob();
        if (turn.id !== turnIdRef.current) {
          interrupted = true;
          return;
        }

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentGroqAudioRef.current = audio;

        await new Promise((resolve) => {
          audio.onplay = () => {
            if (turn.id !== turnIdRef.current) return;
            if (!turn.firstAudioMarked) {
              turn.firstAudioMarked = true;
              setState("speaking");
              setTtfa(performance.now() - recordingStoppedAt.current);
              setTtsDebug({
                provider: "groq",
                roundTripMs: Math.round(performance.now() - fetchStart),
                synthesisMs: synthesisMs ? Number(synthesisMs) : null,
              });
            }
          };
          const settle = () => {
            URL.revokeObjectURL(url);
            if (currentGroqAudioRef.current === audio) currentGroqAudioRef.current = null;
            groqSettleRef.current = null;
            resolve();
          };
          groqSettleRef.current = settle;
          audio.onended = settle;
          audio.onerror = settle;
          audio.play().catch(settle);
        });
      } catch (err) {
        if (err.name === "AbortError" || turn.id !== turnIdRef.current) interrupted = true;
        else console.error("[sarjy] Groq TTS playback failed:", err);
      } finally {
        // After an interrupt, interruptCurrentTurn already reset the shared
        // playback state. Touching it here could clobber a newer turn's.
        if (!interrupted && turn.id === turnIdRef.current) {
          groqPlayingRef.current = false;
          turn.pending -= 1;
          if (groqQueueRef.current.length > 0) drainGroqQueue(turn);
          else maybeFinishTurn(turn);
        }
      }
    },
    [maybeFinishTurn]
  );

  /**
   * Queues one sentence for speech via the provider pinned for this turn.
   * @param {string} text
   * @param {Turn} turn
   * @param {TtsProvider} provider
   */
  const speakSentence = useCallback(
    (text, turn, provider) => {
      const trimmed = text.trim();
      if (!trimmed || turn.id !== turnIdRef.current) return;
      turn.pending += 1;

      if (provider === "groq") {
        groqQueueRef.current.push(trimmed);
        drainGroqQueue(turn);
        return;
      }

      const utter = new SpeechSynthesisUtterance(trimmed);
      utter.lang = "en-US"; // keeps the browser from picking a non-English voice
      if (!turn.firstAudioMarked) {
        turn.firstAudioMarked = true;
        utter.onstart = () => {
          if (turn.id !== turnIdRef.current) return;
          setState("speaking");
          setTtfa(performance.now() - recordingStoppedAt.current);
          setTtsDebug({ provider: "browser", roundTripMs: 0, synthesisMs: null });
        };
      }
      const settle = () => {
        turn.pending -= 1;
        maybeFinishTurn(turn);
      };
      utter.onend = settle;
      utter.onerror = settle;
      window.speechSynthesis.speak(utter);
    },
    [drainGroqQueue, maybeFinishTurn]
  );

  /**
   * Counts a failed turn (unintelligible audio, or a transcription error).
   * After MAX_FAILURE_STREAK in a row, hands-free pauses itself. This stops
   * a noisy room (or Sarjy hearing herself) from looping forever.
   * @returns {boolean} True if hands-free was just paused.
   */
  const registerFailure = useCallback(() => {
    failureStreakRef.current += 1;
    if (failureStreakRef.current >= MAX_FAILURE_STREAK) {
      failureStreakRef.current = 0;
      updateHandsFree(false);
      return true;
    }
    return false;
  }, [updateHandsFree]);

  /**
   * The transcript wasn't clear English: say so and ask the user to repeat.
   * Hands-free then listens again via the normal turn-completion path.
   * @param {number} myTurn
   */
  const handleUnintelligible = useCallback(
    (myTurn) => {
      const gaveUp = registerFailure();
      setErrorText(
        gaveUp
          ? "I'm having trouble hearing you. Tap to start again."
          : "Didn't catch that. Could you say it again in English?"
      );
      /** @type {Turn} */
      const turn = {
        id: myTurn,
        firstAudioMarked: true, // don't overwrite the TTFA of a real reply
        pending: 0,
        streamDone: true,
        finished: false,
      };
      setState("speaking");
      speakSentence(gaveUp ? GIVE_UP_PROMPT : REPEAT_PROMPT, turn, ttsProviderRef.current);
    },
    [registerFailure, speakSentence]
  );

  /**
   * Sends user text to /api/chat and streams the reply, queuing each
   * complete sentence for speech as it arrives.
   * @param {string} userText
   * @param {number} myTurn Epoch this turn started under.
   */
  const sendToChat = useCallback(
    async (userText, myTurn) => {
      const isStale = () => myTurn !== turnIdRef.current;
      const signal = turnAbortRef.current?.signal;

      setState("thinking");
      setMessages((m) => [
        ...m,
        { role: "user", content: userText },
        { role: "assistant", content: "" },
      ]);
      setTtfa(null);
      setTtsDebug(null);
      const localTimings = {};
      const provider = ttsProviderRef.current;

      /** @type {Turn} */
      const turn = {
        id: myTurn,
        firstAudioMarked: false,
        pending: 0,
        streamDone: false,
        finished: false,
      };

      // A cancelled turn can leave an empty "…" reply bubble behind.
      const dropEmptyPlaceholder = () =>
        setMessages((m) => {
          const last = m[m.length - 1];
          return last && last.role === "assistant" && !last.content ? m.slice(0, -1) : m;
        });

      let full = "";
      let sentenceBuffer = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-id": userId.current },
          body: JSON.stringify({ message: userText }),
          signal,
        });
        if (isStale()) return;

        if (!res.ok || !res.body) {
          setErrorText("Sarjy couldn't respond just now. Try again?");
          setState("idle");
          continueIfHandsFree();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Hand-rolled SSE parser: EventSource only supports GET.
        while (true) {
          const { done, value } = await reader.read();
          if (isStale()) return;
          if (done) {
            buffer += decoder.decode();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const raw of events) {
            if (isStale()) return;
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
                speakSentence(sentenceBuffer, turn, provider);
                sentenceBuffer = "";
              }
            } else if (event === "error") {
              setErrorText(data.message);
            }
          }
        }
      } catch (err) {
        if (isStale() || err.name === "AbortError") {
          dropEmptyPlaceholder();
          return;
        }
        console.error("[sarjy] chat stream failed:", err);
        setErrorText("Sarjy couldn't respond just now. Try again?");
        setState("idle");
        continueIfHandsFree();
        return;
      }

      if (isStale()) return;
      if (sentenceBuffer.trim()) speakSentence(sentenceBuffer, turn, provider);
      turn.streamDone = true;
      maybeFinishTurn(turn); // finishes now if there was nothing (left) to say
    },
    [speakSentence, maybeFinishTurn, continueIfHandsFree]
  );

  /**
   * Opens the mic, records, and runs the VAD to auto-stop. Used for the
   * initial tap and for every automatic re-listen.
   * @returns {Promise<void>}
   */
  const startListening = useCallback(async () => {
    if (startingRef.current || mediaRecorderRef.current?.state === "recording") return;
    startingRef.current = true;
    setErrorText(null);
    const myTurn = beginTurn();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      if (myTurn !== turnIdRef.current) {
        // Cancelled while the browser was still granting the mic.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const reason = stopReasonRef.current;
        const heardSpeech = vadRef.current?.hasSpeech ?? false; // read before stopVad clears it
        stopVad();
        stream.getTracks().forEach((t) => t.stop());

        // Cancelled (end conversation / forget me): discard the audio. This
        // is what used to turn the tail of a cancelled recording into a
        // phantom "." message and an extra reply.
        if (myTurn !== turnIdRef.current) return;

        // The VAD never confirmed speech: just silence or noise. Don't send
        // it to Whisper, which would invent text for it. A manual stop is
        // the one exception, since the user explicitly said "I'm done".
        if (!heardSpeech && reason !== "manual") {
          setState("idle");
          continueIfHandsFree();
          return;
        }

        recordingStoppedAt.current = performance.now();
        setState("transcribing");
        const form = new FormData();
        form.append("audio", new Blob(chunksRef.current, { type: "audio/webm" }), "audio.webm");

        let data;
        try {
          const res = await fetch("/api/transcribe", {
            method: "POST",
            body: form,
            signal: turnAbortRef.current?.signal,
          });
          if (!res.ok) throw new Error(`transcribe responded ${res.status}`);
          data = await res.json();
        } catch (err) {
          if (err.name === "AbortError" || myTurn !== turnIdRef.current) return;
          console.error("[sarjy] transcription failed:", err);
          const gaveUp = registerFailure();
          setErrorText(
            gaveUp
              ? "Connection problems, so I've paused. Tap to start again."
              : "Transcription failed. Check your connection."
          );
          setState("idle");
          continueIfHandsFree();
          return;
        }

        if (myTurn !== turnIdRef.current) return;

        if (data.unintelligible || !data.text) {
          handleUnintelligible(myTurn);
          return;
        }

        failureStreakRef.current = 0;
        await sendToChat(data.text, myTurn);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState("listening");
      startVad(stream);
    } catch (err) {
      setErrorText(
        err?.name === "NotFoundError"
          ? "No microphone found. You can type instead below."
          : "Microphone access was denied. You can type instead below."
      );
      updateHandsFree(false); // retrying can't fix a permissions problem
      setState("idle");
    } finally {
      startingRef.current = false;
    }
  }, [
    beginTurn,
    sendToChat,
    startVad,
    stopVad,
    continueIfHandsFree,
    registerFailure,
    handleUnintelligible,
    updateHandsFree,
  ]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  /** Manual stop for push-to-talk: ends the recording and sends it. */
  const stopListening = useCallback(() => safeStopRecorder("manual"), [safeStopRecorder]);

  /**
   * Starts a hands-free session: one tap (the user gesture the browser
   * requires for mic access), then listen -> reply -> listen on its own.
   * @returns {Promise<void>}
   */
  const startConversation = useCallback(async () => {
    failureStreakRef.current = 0;
    updateHandsFree(true);
    await startListening();
  }, [startListening, updateHandsFree]);

  /** Ends the session and immediately silences and cancels everything in flight. */
  const endConversation = useCallback(() => {
    updateHandsFree(false);
    interruptCurrentTurn();
  }, [updateHandsFree, interruptCurrentTurn]);

  /**
   * Typed input. Interrupts whatever is happening first, so a typed message
   * doesn't talk over a reply or race a recording. If hands-free is active
   * it resumes listening after the reply, like a spoken turn.
   * @param {string} text
   */
  const sendTextFallback = useCallback(
    (text) => {
      interruptCurrentTurn();
      const myTurn = beginTurn();
      recordingStoppedAt.current = performance.now();
      sendToChat(text, myTurn);
    },
    [interruptCurrentTurn, beginTurn, sendToChat]
  );

  /**
   * Cancels anything in flight, clears the local conversation, and asks the
   * server to delete this user's stored data. In hands-free, listening
   * resumes afterward (delete the last line to make it wait for a tap).
   * @returns {Promise<void>}
   */
  const forgetMe = useCallback(async () => {
    interruptCurrentTurn();
    failureStreakRef.current = 0;
    setMessages([]);
    setTimings(null);
    setTtfa(null);
    setTtsDebug(null);
    setErrorText(null);

    try {
      await fetch("/api/forget-me", {
        method: "POST",
        headers: { "x-user-id": userId.current },
      });
    } catch (err) {
      console.error("[sarjy] forget-me request failed:", err);
    }

    continueIfHandsFree(); // no-op unless a hands-free session is active
  }, [interruptCurrentTurn, continueIfHandsFree]);

  // Never leave the mic, VAD loop or speech running after unmount.
  useEffect(() => {
    return () => interruptCurrentTurn();
  }, [interruptCurrentTurn]);

  return {
    state,
    handsFree,
    messages,
    errorText,
    timings,
    ttfa,
    ttsProvider,
    setTtsProvider,
    ttsDebug,
    startListening,
    stopListening,
    startConversation,
    endConversation,
    sendTextFallback,
    forgetMe,
  };
}
