import { useCallback, useEffect, useRef, useState } from "react";

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

// --- Voice Activity Detection tuning ---------------------------------
// RMS of the mic's time-domain signal, 0-1. These are starting points, not
// guarantees — mic sensitivity and room noise vary a lot.
const SPEECH_RMS_THRESHOLD = 0.01; // above this = "someone is talking"
const SILENCE_RMS_THRESHOLD = 0.012; // below this = "quiet"
const SILENCE_DURATION_MS = 900; // this much continuous quiet = turn is over
const MIN_SPEECH_MS = 300; // ignore blips shorter than this (coughs, clicks)
const MAX_RECORDING_MS = 20000; // hard cap if silence is never detected
const RELISTEN_DELAY_MS = 400; // pause after Sarjy stops talking before
// listening again — gives speaker audio a moment to fully decay before the
// mic reopens, reducing (not eliminating) Sarjy hearing it own voice.

/**
 * @typedef {"idle" | "listening" | "transcribing" | "thinking" | "speaking"} VoiceState
 * Current phase of the voice turn.
 * - `idle`: no active turn. In hands-free mode this is a transient state
 *   between turns, not a resting state the user has to act from.
 * - `listening`: microphone is open; VAD is watching for silence to auto-stop.
 * - `transcribing`: audio is being sent to `/api/transcribe`.
 * - `thinking`: waiting for / streaming the LLM reply from `/api/chat`.
 * - `speaking`: one or more sentences are queued/playing via the selected TTS provider.
 */

/**
 * @typedef {"browser" | "groq"} TtsProvider
 * - `browser`: the Web Speech API's `speechSynthesis` — zero network cost,
 *   synthesis happens locally on the user's device.
 * - `groq`: `/api/speak`, which calls Groq's TTS endpoint and returns audio
 *   bytes — a real network + inference round trip per sentence.
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
 * avoid cross-machine clock-skew error.
 * @property {number} [key] e.g. memory_loaded, llm_first_token, tool_call_detected,
 *   tool_result, llm_first_token_after_tool, llm_done.
 */

/**
 * @typedef {Object} TtsDebug
 * @property {TtsProvider} provider Which provider produced this turn's audio.
 * @property {number} roundTripMs Client-measured fetch-to-first-audio time.
 *   Always 0 for `browser`.
 * @property {number | null} synthesisMs Server-reported pure synthesis time
 *   (from `X-Synthesis-Ms`). `null` for `browser`.
 */

/**
 * @typedef {Object} UseVoiceChatResult
 * @property {VoiceState} state Current phase of the voice turn.
 * @property {boolean} handsFree Whether a hands-free session is active —
 *   while true, the hook auto-chains listening after every turn.
 * @property {ChatMessage[]} messages Conversation history, oldest first.
 * @property {string | null} errorText User-facing error message, or `null`.
 * @property {TurnTimings | null} timings Server-reported latency checkpoints
 *   for the latest turn.
 * @property {number | null} ttfa Time-to-first-audible-word for the latest
 *   turn, in ms, from mic-release/VAD-stop to the first spoken utterance
 *   actually starting.
 * @property {TtsProvider} ttsProvider Which TTS provider new turns will use.
 * @property {(provider: TtsProvider) => void} setTtsProvider
 * @property {TtsDebug | null} ttsDebug Comparison timing for the latest turn.
 * @property {() => Promise<void>} startConversation Requests the mic and
 *   begins a hands-free session: listen -> respond -> listen again,
 *   automatically, until `endConversation` is called.
 * @property {() => void} endConversation Ends the hands-free session,
 *   immediately stops any in-progress recording or playback, and returns
 *   to `idle`.
 * @property {(text: string) => void} sendTextFallback Sends typed text through
 *   the same chat -> speak pipeline, bypassing the microphone. Works whether
 *   or not a hands-free session is active.
 * @property {() => Promise<void>} forgetMe Asks the server to delete this
 *   user's stored data and clears local messages.
 */

/**
 * React hook that drives a hands-free voice assistant.
 *
 * `startConversation()` is the one required user gesture (browsers won't
 * grant mic access without one). After that, the turn pipeline repeats on
 * its own with no further taps:
 *
 * `listening (VAD watches for silence) -> transcribing -> thinking -> speaking -> listening -> ...`
 *
 * VAD (see the tuning constants above the typedefs) replaces manual
 * start/stop: a `Web Audio` `AnalyserNode` reads mic volume on an animation
 * frame loop, and recording auto-stops once ~900ms of silence follows
 * detected speech, or after `MAX_RECORDING_MS` regardless, whichever comes
 * first — recording.state is always checked before calling `.stop()` since
 * either path (or a manual `endConversation`) could fire first.
 *
 * Auto-chaining the next listen is done via explicit calls at each real
 * "turn complete" point (end of TTS playback, or an empty/failed
 * transcription), not by watching `state` in a `useEffect` — `state` passes
 * through `idle` for reasons that aren't "ready for the next turn" too
 * (initial mount, a manual stop), so a generic watcher would be unreliable.
 *
 * `endConversation()` immediately silences whatever's playing (cancels
 * `speechSynthesis` and/or pauses the current Groq `<audio>`), not just the
 * next listen — this matters a lot for how responsive it feels to exit.
 *
 * @returns {UseVoiceChatResult}
 */
export function useVoiceChat() {
  /** @type {[VoiceState, Function]} */
  const [state, setState] = useState("idle");
  /** @type {[boolean, Function]} */
  const [handsFree, setHandsFree] = useState(false);
  /** @type {[ChatMessage[], Function]} */
  const [messages, setMessages] = useState([]);
  /** @type {[string | null, Function]} */
  const [errorText, setErrorText] = useState(null);
  /** @type {[TurnTimings | null, Function]} */
  const [timings, setTimings] = useState(null);
  /** @type {[number | null, Function]} */
  const [ttfa, setTtfa] = useState(null);
  /** @type {[TtsProvider, Function]} */
  const [ttsProvider, setTtsProvider] = useState("browser");
  /** @type {[TtsDebug | null, Function]} */
  const [ttsDebug, setTtsDebug] = useState(null);

  const userId = useRef(getUserId());
  const recordingStoppedAt = useRef(0);

  /** Mirrors `handsFree` so async callbacks always read the current value,
   *  not whatever it was when that callback was created. */
  const handsFreeRef = useRef(false);
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  const ttsProviderRef = useRef(ttsProvider);
  useEffect(() => {
    ttsProviderRef.current = ttsProvider;
  }, [ttsProvider]);

  // --- recording / VAD refs ---
  const mediaRecorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const vadRafRef = useRef(null);
  const vadTimeoutRef = useRef(null);

  // --- playback refs (so endConversation can interrupt immediately) ---
  const groqQueueRef = useRef([]);
  const groqPlayingRef = useRef(false);
  const currentGroqAudioRef = useRef(null);

  /**
   * Stops the MediaRecorder exactly once, however it was triggered (VAD
   * silence, the max-duration timeout, or a manual endConversation) —
   * calling `.stop()` on an already-stopped recorder throws, so every
   * trigger path goes through this guard instead of calling it directly.
   */
  const safeStopRecorder = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  /**
   * Tears down the VAD animation loop and the AudioContext built for it.
   * Called whenever a recording ends, by whatever means, so a stale loop
   * never keeps running against a closed stream.
   */
  const stopVad = useCallback(() => {
    if (vadRafRef.current) cancelAnimationFrame(vadRafRef.current);
    vadRafRef.current = null;
    if (vadTimeoutRef.current) clearTimeout(vadTimeoutRef.current);
    vadTimeoutRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  /**
   * Watches mic volume on an animation-frame loop and calls `safeStopRecorder`
   * once ~`SILENCE_DURATION_MS` of quiet follows at least `MIN_SPEECH_MS` of
   * detected speech. This is what makes recording stop without a button
   * press. A separate `MAX_RECORDING_MS` timeout force-stops regardless, in
   * case background noise means silence is never cleanly detected.
   *
   * @param {MediaStream} stream The mic stream also feeding the MediaRecorder.
   */
  const startVad = useCallback(
    (stream) => {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextCtor();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      let speechStartedAt = null;
      let lastLoudAt = null;

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const normalized = (data[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = performance.now();

        if (rms > SPEECH_RMS_THRESHOLD) {
          if (!speechStartedAt) speechStartedAt = now;
          lastLoudAt = now;
        }

        const hasEnoughSpeech =
          speechStartedAt && now - speechStartedAt >= MIN_SPEECH_MS;
        const hasGoneQuiet =
          rms < SILENCE_RMS_THRESHOLD &&
          lastLoudAt &&
          now - lastLoudAt >= SILENCE_DURATION_MS;

        if (hasEnoughSpeech && hasGoneQuiet) {
          safeStopRecorder();
          return; // onstop handler takes over; no need to keep ticking
        }

        vadRafRef.current = requestAnimationFrame(tick);
      };

      vadRafRef.current = requestAnimationFrame(tick);
      vadTimeoutRef.current = setTimeout(safeStopRecorder, MAX_RECORDING_MS);
    },
    [safeStopRecorder]
  );

  /**
   * If a hands-free session is still active, waits a short beat (to let any
   * just-finished speaker audio decay before the mic reopens) and then
   * starts listening again. Called from every real "turn complete" point —
   * never from a generic `state === "idle"` watcher, since idle also occurs
   * for reasons that aren't "ready for the next turn."
   */
  const continueIfHandsFree = useCallback(() => {
    if (!handsFreeRef.current) return;
    setTimeout(() => {
      if (handsFreeRef.current) startListeningRef.current?.();
    }, RELISTEN_DELAY_MS);
  }, []);

  // startListening is defined below but referenced by continueIfHandsFree
  // above it — a ref indirection avoids a circular useCallback dependency.
  const startListeningRef = useRef(null);

  /**
   * Plays the next queued sentence through `/api/speak` (Groq TTS), one at a
   * time, in order — `<audio>` elements don't queue themselves the way
   * `speechSynthesis` does, so this provides that ordering manually.
   * Chains back into listening via {@link continueIfHandsFree} once the
   * queue is fully drained.
   *
   * @param {{ isFirst: boolean }} flags Mutated in place; shared across a turn.
   * @param {React.MutableRefObject<number>} pendingRef Count of utterances
   *   still queued/playing for this turn, shared across both providers.
   */
  const drainGroqQueue = useCallback(
    async (flags, pendingRef) => {
      if (groqPlayingRef.current) return;
      const text = groqQueueRef.current.shift();
      if (!text) return;
      groqPlayingRef.current = true;

      const fetchStart = performance.now();
      try {
        const res = await fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error("TTS request failed");
        const synthesisMs = res.headers.get("X-Synthesis-Ms");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentGroqAudioRef.current = audio;

        await new Promise((resolve) => {
          audio.onplay = () => {
            if (flags.isFirst) {
              flags.isFirst = false;
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
            if (currentGroqAudioRef.current === audio)
              currentGroqAudioRef.current = null;
            resolve();
          };
          audio.onended = settle;
          audio.onerror = settle;
          audio.play().catch(settle);
        });
      } catch (err) {
        console.error("[sarjy] Groq TTS playback failed:", err);
      } finally {
        pendingRef.current -= 1;
        groqPlayingRef.current = false;
        if (pendingRef.current <= 0 && groqQueueRef.current.length === 0) {
          setState("idle");
          continueIfHandsFree();
        } else {
          drainGroqQueue(flags, pendingRef);
        }
      }
    },
    [continueIfHandsFree]
  );

  /**
   * Queues one sentence for speech via whichever provider was pinned for
   * this turn. The browser path chains back into listening (via
   * {@link continueIfHandsFree}) once the LAST queued utterance finishes;
   * the Groq path does the equivalent inside {@link drainGroqQueue}.
   *
   * @param {string} text Sentence to speak.
   * @param {{ isFirst: boolean }} flags Mutated in place; shared across a turn.
   * @param {React.MutableRefObject<number>} pendingRef
   * @param {TtsProvider} provider Provider pinned for this turn.
   */
  const speakSentence = useCallback(
    (text, flags, pendingRef, provider) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pendingRef.current += 1;

      if (provider === "groq") {
        groqQueueRef.current.push(trimmed);
        drainGroqQueue(flags, pendingRef);
        return;
      }

      const utter = new SpeechSynthesisUtterance(trimmed);
      if (flags.isFirst) {
        flags.isFirst = false;
        utter.onstart = () => {
          setState("speaking");
          setTtfa(performance.now() - recordingStoppedAt.current);
          setTtsDebug({
            provider: "browser",
            roundTripMs: 0,
            synthesisMs: null,
          });
        };
      }
      const onSettled = () => {
        pendingRef.current -= 1;
        if (pendingRef.current <= 0) {
          setState("idle");
          continueIfHandsFree();
        }
      };
      utter.onend = onSettled;
      utter.onerror = onSettled;
      window.speechSynthesis.speak(utter);
    },
    [drainGroqQueue, continueIfHandsFree]
  );

  /**
   * Sends user text to `/api/chat` and streams the reply, queuing each
   * complete sentence to speech as it arrives rather than waiting for the
   * full reply (see {@link speakSentence}).
   *
   * @param {string} userText
   * @returns {Promise<void>}
   */
  const sendToChat = useCallback(
    async (userText) => {
      setState("thinking");
      setMessages((m) => [...m, { role: "user", content: userText }]);
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      setTtfa(null);
      setTtsDebug(null);
      const localTimings = {};
      const provider = ttsProviderRef.current;

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
        continueIfHandsFree();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      let sentenceBuffer = "";

      const speakFlags = { isFirst: true };
      const pendingUtterances = { current: 0 };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
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
              speakSentence(
                sentenceBuffer,
                speakFlags,
                pendingUtterances,
                provider
              );
              sentenceBuffer = "";
            }
          } else if (event === "error") {
            setErrorText(data.message);
          }
        }
      }

      if (sentenceBuffer.trim()) {
        speakSentence(sentenceBuffer, speakFlags, pendingUtterances, provider);
      } else if (pendingUtterances.current === 0) {
        // Empty/failed reply — nothing was queued to chain the next listen,
        // so do it here instead.
        setState("idle");
        continueIfHandsFree();
      }
    },
    [speakSentence, continueIfHandsFree]
  );

  /**
   * Opens the mic, starts recording, and starts the VAD loop watching it.
   * Used both for the user's initial `startConversation()` tap and for
   * every automatic re-listen {@link continueIfHandsFree} triggers.
   *
   * `echoCancellation`/`noiseSuppression`/`autoGainControl` are requested on
   * the mic stream — helps (doesn't fully solve) the mic picking up Sarjy's
   * own voice when played through speakers rather than headphones.
   *
   * @returns {Promise<void>}
   */
  const startListening = useCallback(async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        recordingStoppedAt.current = performance.now();
        stopVad();
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", blob, "audio.webm");

        try {
          const res = await fetch("/api/transcribe", {
            method: "POST",
            body: form,
          });
          const data = await res.json();
          if (!res.ok || !data.text) {
            setErrorText("Didn't catch that — mind trying again?");
            setState("idle");
            continueIfHandsFree();
            return;
          }
          await sendToChat(data.text);
        } catch {
          setErrorText("Transcription failed — check your connection.");
          setState("idle");
          continueIfHandsFree();
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setState("listening");
      startVad(stream);
    } catch {
      setErrorText("Microphone access was denied. You can type instead below.");
      setHandsFree(false); // permission issues won't resolve themselves — don't keep retrying
      setState("idle");
    }
  }, [sendToChat, startVad, stopVad, continueIfHandsFree]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  /**
   * Begins a hands-free session: the one required user gesture for mic
   * permission, after which turns chain automatically with no further taps.
   *
   * @returns {Promise<void>}
   */
  const startConversation = useCallback(async () => {
    setHandsFree(true);
    await startListening();
  }, [startListening]);

  /**
   * Ends the hands-free session and immediately silences whatever's
   * playing — cancels queued/playing browser speech, pauses the current
   * Groq `<audio>` if one is playing, stops any in-progress recording, and
   * tears down the VAD loop. Does NOT clear the conversation transcript.
   */
  const endConversation = useCallback(() => {
    setHandsFree(false);
    window.speechSynthesis.cancel();
    if (currentGroqAudioRef.current) {
      currentGroqAudioRef.current.pause();
      currentGroqAudioRef.current = null;
    }
    groqQueueRef.current = [];
    safeStopRecorder();
    stopVad();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    setState("idle");
  }, [safeStopRecorder, stopVad]);

  /**
   * Text-input alternative to the mic. Works whether or not a hands-free
   * session is active — if it is, the next listen still auto-chains once
   * this reply finishes, same as a spoken turn would.
   *
   * @param {string} text
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
   * local conversation.
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

  // Make sure a page navigation/unmount can't leave the mic or VAD running.
  useEffect(() => {
    return () => {
      safeStopRecorder();
      stopVad();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      window.speechSynthesis.cancel();
    };
  }, [safeStopRecorder, stopVad]);

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
    startConversation,
    endConversation,
    startListening,                 
    stopListening: safeStopRecorder,
    sendTextFallback,
    forgetMe,
  };
}
