import SarjyAvatar from "./SarjyAvatar";

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
    <div className="mic-wrap"  onClick={handleClick}>
      <SarjyAvatar state={state} audioLevel={0.7} />
      <p className="mic-label">{label}</p>
    </div>
  );
}
