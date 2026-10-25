/**
 * Voice activity detector (VAD). Pure logic with no DOM or Web Audio
 * dependencies, so it can be unit-tested with synthetic input. The hook feeds
 * it one RMS reading per animation frame via `update(rms, nowMs)`.
 *
 * Why this replaced the fixed-threshold version:
 *
 * 1. Thresholds are relative to a measured noise floor, not absolute. A fixed
 *    "0.02 means speech" works on one mic in one room and fails everywhere
 *    else (fans, laptop mics, USB headsets all sit at different baselines).
 * 2. "Minimum speech" is accumulated *voiced time*, not time since the first
 *    loud frame. The old check counted a single click followed by silence as
 *    speech, which then got sent to Whisper and came back as gibberish.
 * 3. Two thresholds (hysteresis): louder to START speech, quieter to count as
 *    silence, so natural dips between words don't end the utterance.
 * 4. Speech must stay loud for `onsetMs` before it counts, which rejects
 *    keyboard clicks and door slams.
 *
 * Tuning: set VAD_DEBUG in useVoiceChat.js to log live levels, then adjust
 * the values below. See the comments on each option.
 */

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export const VAD_DEFAULTS = {
  // --- how thresholds are derived from the noise floor ---
  speechMultiplier: 3, // speech threshold = noiseFloor x this (about +9.5 dB)
  silenceMultiplier: 1.8, // "quiet again" threshold = noiseFloor x this
  minSpeechRms: 0.012, // lower bound on the speech threshold (quiet rooms)
  maxSpeechRms: 0.12, // upper bound (so a loud room can't make you unhearable)
  minSilenceRms: 0.006, // lower bound on the silence threshold

  // --- timing ---
  onsetMs: 100, // loudness must persist this long to count as speech starting
  minVoicedMs: 250, // total voiced time needed before an utterance is "real"
  silenceMs: 900, // continuous quiet that ends the utterance

  // --- noise floor estimation ---
  calibrationMs: 300, // ambient measurement at the start of the first listen
  minNoiseFloor: 0.001,
  maxNoiseFloor: 0.03, // a calibration above this is treated as contaminated
  fallbackNoiseFloor: 0.005, // ...and replaced with this
  floorFallTauMs: 200, // floor follows quiet-downs quickly
  floorRiseTauMs: 5000, // ...but rises slowly, so speech can't drag it up

  // --- smoothing ---
  rmsSmoothingTauMs: 20, // smooths frame jitter; longer values add a decay tail that inflates short bursts
  maxFrameMs: 100, // cap on one frame's dt (throttled tabs, GC pauses)
};

/**
 * @param {Partial<typeof VAD_DEFAULTS> & { initialNoiseFloor?: number | null }} [options]
 *   `initialNoiseFloor` carries the previous turn's floor into the next one,
 *   which skips calibration. That matters in hands-free mode, where the user
 *   may start talking right as the mic reopens and would otherwise
 *   contaminate the calibration window.
 */
export function createVad(options = {}) {
  const { initialNoiseFloor = null, ...overrides } = options;
  const cfg = { ...VAD_DEFAULTS, ...overrides };

  let lastTs = null;
  let smoothed = null;
  let noiseFloor = initialNoiseFloor;
  let calibMs = 0;
  let calibMin = Infinity;
  let phase = "waiting"; // "waiting" for speech, or "speech" in progress
  let loudMs = 0; // consecutive loud time while waiting (onset debounce)
  let voicedMs = 0; // accumulated voiced time within the current utterance
  let quietMs = 0; // consecutive quiet time within the current utterance
  let confirmed = false; // has this recording contained real speech?

  const alpha = (dt, tau) => (dt > 0 ? 1 - Math.exp(-dt / tau) : 1);

  function thresholds() {
    const floor = noiseFloor ?? cfg.fallbackNoiseFloor;
    const speech = clamp(floor * cfg.speechMultiplier, cfg.minSpeechRms, cfg.maxSpeechRms);
    const silence = clamp(floor * cfg.silenceMultiplier, cfg.minSilenceRms, speech * 0.75);
    return { speech, silence };
  }

  function snapshot(stop, reason) {
    const t = thresholds();
    return {
      stop,
      reason,
      phase,
      rms: smoothed,
      noiseFloor,
      speechThreshold: t.speech,
      silenceThreshold: t.silence,
    };
  }

  /**
   * @param {number} rms Raw RMS of the latest audio frame, 0 to 1.
   * @param {number} now Timestamp in ms (performance.now()).
   * @returns {{ stop: boolean, reason?: string, phase: string, rms: number,
   *   noiseFloor: number | null, speechThreshold: number, silenceThreshold: number }}
   *   `stop` becomes true once a confirmed utterance has been followed by
   *   `silenceMs` of quiet.
   */
  function update(rms, now) {
    const dt = lastTs == null ? 0 : Math.min(now - lastTs, cfg.maxFrameMs);
    lastTs = now;
    smoothed = smoothed == null ? rms : smoothed + alpha(dt, cfg.rmsSmoothingTauMs) * (rms - smoothed);

    // 1. Calibrate the noise floor (first listen only). The window's minimum
    //    is used rather than its mean, so speech starting during calibration
    //    doesn't inflate it.
    if (noiseFloor == null) {
      calibMin = Math.min(calibMin, smoothed);
      calibMs += dt;
      if (calibMs >= cfg.calibrationMs) {
        noiseFloor =
          calibMin > cfg.maxNoiseFloor
            ? cfg.fallbackNoiseFloor
            : Math.max(calibMin, cfg.minNoiseFloor);
      }
      return snapshot(false);
    }

    const t = thresholds();

    if (phase === "waiting") {
      // Track ambient noise while nobody is talking.
      if (smoothed < t.speech) {
        const tau = smoothed < noiseFloor ? cfg.floorFallTauMs : cfg.floorRiseTauMs;
        noiseFloor += alpha(dt, tau) * (smoothed - noiseFloor);
      }
      if (smoothed > t.speech) {
        loudMs += dt;
        if (loudMs >= cfg.onsetMs) {
          phase = "speech";
          voicedMs = loudMs;
          quietMs = 0;
        }
      } else {
        loudMs = 0;
      }
    } else {
      if (smoothed > t.silence) {
        voicedMs += dt;
        quietMs = 0;
      } else {
        quietMs += dt;
      }
      if (voicedMs >= cfg.minVoicedMs) confirmed = true;

      if (quietMs >= cfg.silenceMs) {
        if (confirmed) return snapshot(true, "silence");
        // Too short to be speech (a cough, a click). Keep recording and wait again.
        phase = "waiting";
        loudMs = 0;
        voicedMs = 0;
        quietMs = 0;
      }
    }

    return snapshot(false);
  }

  return {
    update,
    /** True once this recording has contained at least `minVoicedMs` of speech. */
    get hasSpeech() {
      return confirmed;
    },
    /** Current noise floor, or null if still calibrating. Persist it between turns. */
    getNoiseFloor() {
      return noiseFloor;
    },
  };
}
