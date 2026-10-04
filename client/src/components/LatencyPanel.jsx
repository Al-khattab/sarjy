import { useState } from "react";

const STAGE_LABELS = {
  memory_loaded: "Memory loaded (DB)",
  llm_first_token: "First token (LLM)",
  tool_call_detected: "Tool call detected",
  tool_result: "Weather tool result",
  llm_first_token_after_tool: "First token after tool",
  llm_done: "Reply complete",
};

// Server order doesn't always match display order (e.g. tool stages only
// appear some turns) — this fixes a sensible left-to-right reading order
// regardless of what's present.
const STAGE_ORDER = [
  "memory_loaded",
  "llm_first_token",
  "tool_call_detected",
  "tool_result",
  "llm_first_token_after_tool",
  "llm_done",
];

export function LatencyPanel({ timings, ttfa }) {
  const [open, setOpen] = useState(false);

  if (!timings && ttfa == null) return null;

  // timings values are already ms-since-request-received (server-relative),
  // not absolute timestamps — no subtraction needed, just display them.
  const rows = Object.entries(timings || {})
    .sort(([a], [b]) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b))
    .map(([key, ms]) => ({
      label: STAGE_LABELS[key] || key,
      ms,
    }));

  return (
    <div className="latency-panel">
      <button className="latency-panel__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} latency breakdown
      </button>
      {open && (
        <>
          {ttfa != null && (
            <p className="latency-panel__ttfa">
              Time to first audible word: <strong>{Math.round(ttfa)} ms</strong>
            </p>
          )}
          <table className="latency-panel__table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td>{r.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}