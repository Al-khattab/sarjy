import { useState } from "react";

const STAGE_LABELS = {
  llm_decision: "Tool-call decision",
  tool_result: "Weather tool result",
  llm_first_token: "First token (LLM)",
  llm_done: "Reply complete",
};

export function LatencyPanel({ timings }) {
  const [open, setOpen] = useState(false);

  if (!timings) return null;
  const start = timings.turn_start;
  const rows = Object.entries(timings)
    .filter(([key]) => key !== "turn_start")
    .map(([key, at]) => ({
      label: STAGE_LABELS[key] || key,
      ms: at - start,
    }));

  return (
    <div className="latency-panel">
      <button className="latency-panel__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} latency breakdown
      </button>
      {open && (
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
      )}
    </div>
  );
}
