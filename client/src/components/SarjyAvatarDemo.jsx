import React, { useState } from "react";
import SarjyAvatar from "./SarjyAvatar.jsx";

const STATES = ["idle", "listening", "transcribing", "thinking", "speaking", "error"];

export default function SarjyAvatarDemo() {
  const [state, setState] = useState("idle");
  const [level, setLevel] = useState(0.4);
  const [useLevel, setUseLevel] = useState(false);

  const btn = (active) => ({
    padding: "8px 12px", borderRadius: 8, cursor: "pointer", font: "500 12px Inter, sans-serif",
    background: active ? "#b98a3d" : "#1c1c16", color: active ? "#14140f" : "#f3f1e8",
    border: "1px solid #34321f",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#14140f", color: "#f3f1e8", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 64, padding: 24,
      fontFamily: "Inter, sans-serif" }}>
      <SarjyAvatar state={state} audioLevel={useLevel ? level : undefined} />
      <div style={{ width: "100%", maxWidth: 400, background: "#1c1c16", border: "1px solid #34321f",
        borderRadius: 14, padding: 16, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {STATES.map((s) => (
            <button key={s} style={btn(state === s)} onClick={() => setState(s)}>{s}</button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#a6a293" }}>
          <input type="checkbox" checked={useLevel} onChange={(e) => setUseLevel(e.target.checked)} />
          Drive audioLevel manually
        </label>
        <input type="range" min={0} max={1} step={0.01} value={level} disabled={!useLevel}
          onChange={(e) => setLevel(+e.target.value)} style={{ accentColor: "#b98a3d" }} />
      </div>
    </div>
  );
}
