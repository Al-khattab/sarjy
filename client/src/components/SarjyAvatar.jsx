import React, { useEffect, useRef, useState } from "react";

/**
 * <SarjyAvatar state="idle|listening|transcribing|thinking|speaking|error" audioLevel={0..1} />
 * Purely presentational. Plain React + inline CSS. No WebGL.
 */

const COLORS = {
  idle: [185, 138, 61],
  speaking: [185, 138, 61],
  listening: [95, 179, 163],
  transcribing: [166, 162, 147],
  thinking: [166, 162, 147],
  error: [193, 85, 60],
};

function Ticks({ r, n, len, w, op }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const long = i % (n / 4) === 0;
    const l = long ? len * 2.2 : len;
    const f = (v) => Math.round(v * 1000) / 1000;
    out.push(
      <line key={i} x1={f(50 + Math.cos(a) * r)} y1={f(50 + Math.sin(a) * r)}
        x2={f(50 + Math.cos(a) * (r - l))} y2={f(50 + Math.sin(a) * (r - l))}
        strokeWidth={long ? w * 2 : w} opacity={long ? 1 : op} />
    );
  }
  return out;
}

export default function SarjyAvatar({ state = "idle", audioLevel }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(state);
  const target = useRef({ lvl: 0, px: 0, py: 0 });
  const cur = useRef({ lvl: 0, px: 0, py: 0, c: [...COLORS.idle] });
  const levelProp = useRef(audioLevel);
  const stateRef = useRef(shown);
  levelProp.current = audioLevel;
  stateRef.current = shown;

  // error flashes then returns to idle
  useEffect(() => {
    setShown(state);
    if (state === "error") {
      const t = setTimeout(() => setShown("idle"), 1100);
      return () => clearTimeout(t);
    }
  }, [state]);

  // mouse parallax
  useEffect(() => {
    const onMove = (e) => {
      const el = ref.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      const x = (e.clientX - (b.left + b.width / 2)) / (window.innerWidth / 2);
      const y = (e.clientY - (b.top + b.height / 2)) / (window.innerHeight / 2);
      target.current.px = Math.max(-1, Math.min(1, x));
      target.current.py = Math.max(-1, Math.min(1, y));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // animation loop: smoothing + listening deformation
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf;
    const start = performance.now();
    const tick = (now) => {
      const t = (now - start) / 1000;
      const s = stateRef.current;
      const el = ref.current;
      if (el) {
        const p = levelProp.current;
        let lvl;
        if (typeof p === "number") lvl = Math.max(0, Math.min(1, p));
        else if (s === "listening") lvl = 0.35 + 0.3 * Math.sin(t * 3.1) * Math.sin(t * 1.7);
        else if (s === "speaking") lvl = 0.45 + 0.4 * Math.abs(Math.sin(t * 4.3) * Math.sin(t * 2.2));
        else lvl = 0.12 + 0.1 * Math.sin(t * 1.2);
        if (s === "thinking" || s === "transcribing") lvl *= 0.4;
        if (s === "idle" && typeof p === "number") lvl *= 0.5;
        target.current.lvl = lvl;

        const c = cur.current;
        const up = target.current.lvl > c.lvl;
        const k = s === "speaking" ? (up ? 0.45 : 0.15) : up ? 0.25 : 0.08;
        c.lvl += (target.current.lvl - c.lvl) * k;
        c.px += (target.current.px - c.px) * 0.06;
        c.py += (target.current.py - c.py) * 0.06;
        const tc = COLORS[s] || COLORS.idle;
        for (let i = 0; i < 3; i++) c.c[i] += (tc[i] - c.c[i]) * 0.08;

        el.style.setProperty("--lvl", c.lvl.toFixed(3));
        el.style.setProperty("--c", c.c.map((v) => v.toFixed(0)).join(","));
        if (!reduce) {
          el.style.setProperty("--px", c.px.toFixed(3));
          el.style.setProperty("--py", c.py.toFixed(3));
        }
        if (s === "listening" && !reduce) {
          const a = c.lvl * 14;
          const r = (ph) => (50 + a * Math.sin(t * 2.3 + ph)).toFixed(1);
          el.style.setProperty("--shape",
            `${r(0)}% ${r(1.3)}% ${r(2.6)}% ${r(3.9)}% / ${r(4.7)}% ${r(0.8)}% ${r(2.1)}% ${r(5.2)}%`);
        } else el.style.setProperty("--shape", "50%");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={ref} className="sarjy" data-s={shown} role="img" aria-label={`Sarjy — ${shown}`}>
      {/* <style>{CSS}</style> */}
      <div className="sarjy-l sarjy-shadow" />
      <div className="sarjy-float">
        <div className="sarjy-l sarjy-aura" />
        <div className="sarjy-l sarjy-ripple" />
        <div className="sarjy-l sarjy-ripple d2" />
        <div className="sarjy-l sarjy-ripple d3" />
        <div className="sarjy-l sarjy-ring">
          <svg viewBox="0 0 100 100" fill="none" stroke="rgb(var(--c))">
            <g className="r1">
              <circle cx="50" cy="50" r="48" strokeWidth=".25" opacity=".5" />
              <Ticks r={48} n={72} len={1.6} w={0.25} op={0.45} />
            </g>
            <g className="r2">
              <circle cx="50" cy="50" r="41" strokeWidth=".4" strokeDasharray="18 6 2 6" opacity=".7" />
              <circle cx="50" cy="9" r=".9" fill="rgb(var(--c))" stroke="none" />
            </g>
          </svg>
        </div>
        <div className="sarjy-l sarjy-core">
          <div className="sarjy-inner" />
          <div className="sarjy-grid" />
        </div>
        <div className="sarjy-l sarjy-spec" />
      </div>
      {/* <div className="sarjy-label"><b>سرج</b>Sarjy · {shown}</div> */}
    </div>
  );
}
