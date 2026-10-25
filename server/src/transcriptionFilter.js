// Decides whether a Whisper `verbose_json` result is usable English speech.
//
// Whisper's failure modes on noisy or near-silent audio are well known: it
// invents text (often "Thank you." or a repeating loop), misdetects the
// language on short clips, and emits other scripts. None of that is
// reported as an error, so it has to be filtered out here, before the text
// reaches the LLM and gets a confident reply.
//
// The segment thresholds below are Whisper's own defaults for detecting
// silence and failed decodes (no_speech_threshold 0.6, logprob_threshold
// -1.0, compression_ratio_threshold 2.4). Tune them against the rejection
// logs this module produces if they turn out too strict or too lenient.

const NO_SPEECH_PROB = 0.6;
const AVG_LOGPROB_SILENT = -1.0; // combined with no_speech_prob above
const AVG_LOGPROB_JUNK = -1.5; // so low the segment is junk regardless
const COMPRESSION_RATIO = 2.4; // repetitive loops ("you you you you...")
const MIN_LATIN_RATIO = 0.8; // share of letters that must be Latin script

function reject(reason, detail) {
  return { ok: false, reason, detail, text: "" };
}

function isConfidentSegment(segment) {
  const noSpeech = segment.no_speech_prob ?? 0;
  const logprob = segment.avg_logprob ?? 0;
  const compression = segment.compression_ratio ?? 0;

  if (noSpeech > NO_SPEECH_PROB && logprob < AVG_LOGPROB_SILENT) return false;
  if (compression > COMPRESSION_RATIO) return false;
  if (logprob < AVG_LOGPROB_JUNK) return false;
  return true;
}

/**
 * @param {object} result Parsed Whisper `verbose_json` response.
 * @param {{ requireEnglish?: boolean }} [options] Set requireEnglish to false
 *   when the request already forced `language: "en"`; Whisper then reports
 *   whatever it was told, so the language check would be meaningless.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string, detail?: string, text: "" }}
 */
export function evaluateTranscription(result, { requireEnglish = true } = {}) {
  // 1. Language gate. Whisper reports a lowercase language name ("english").
  if (requireEnglish) {
    const language = String(result?.language ?? "").toLowerCase();
    if (language && language !== "english" && language !== "en") {
      return reject("non_english", language);
    }
  }

  // 2. Drop hallucinated or low-confidence segments, keep the rest.
  let text = String(result?.text ?? "").trim();
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  if (segments.length > 0) {
    const kept = segments.filter(isConfidentSegment);
    if (kept.length === 0) {
      return reject("low_confidence", `${segments.length} segment(s) rejected`);
    }
    text = kept
      .map((s) => String(s.text ?? "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  // 3. Script check: catches foreign-script output even if the language
  //    field was missing or wrong.
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length > 0) {
    const latin = text.match(/\p{Script=Latin}/gu) ?? [];
    if (latin.length / letters.length < MIN_LATIN_RATIO) {
      return reject("non_latin_script", text.slice(0, 40));
    }
  }

  // 4. Needs real content, not just punctuation like "." or "...".
  const alphanumeric = text.replace(/[^\p{L}\p{N}]/gu, "");
  if (alphanumeric.length < 2) {
    return reject("empty", JSON.stringify(text));
  }

  return { ok: true, text };
}
