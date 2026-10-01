export function MicButton({ state, onStart, onStop }) {
  const label = {
    idle: "Talk to Sarjy",
    listening: "Listening — tap to stop",
    transcribing: "Reading that back…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  }[state];

  const handleClick = () => {
    if (state === "idle") onStart();
    else if (state === "listening") onStop();
  };

  const disabled = state === "transcribing" || state === "thinking" || state === "speaking";

  return (
    <div className="mic-wrap">
      <button
        className={`mic-orb mic-orb--${state}`}
        onClick={handleClick}
        disabled={disabled}
        aria-label={label}
      >
        <span className="mic-orb__ring" />
        <span className="mic-orb__core" />
      </button>
      <p className="mic-label">{label}</p>
    </div>
  );
}
