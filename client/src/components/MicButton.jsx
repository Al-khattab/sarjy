import SarjyAvatar from "./SarjyAvatar";

const PTT_LABELS = {
  idle: "Talk to Sarjy",
  listening: "Listening — tap to stop",
  transcribing: "Reading that back…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

const HANDS_FREE_LABELS = {
  idle: "Start conversation",
  listening: "Listening — tap to end",
  transcribing: "Reading that back… — tap to end",
  thinking: "Thinking… — tap to end",
  speaking: "Speaking… — tap to end",
};

/**
 * Mic control that drives either push-to-talk or hands-free interaction,
 * chosen by the `handsFree` prop — see the mode toggle in App.jsx, which
 * decides which pair of callbacks gets wired up before the next tap.
 *
 * - Push-to-talk: tap to start a single turn; tap again while listening to
 *   stop it manually. (The hook's VAD will also auto-stop on silence either
 *   way — this just lets the user end early.) Disabled mid-turn
 *   (transcribing/thinking/speaking), matching the original design.
 * - Hands-free: tap once to start a session that keeps listening and
 *   responding on its own with no further taps; tapping again at ANY point
 *   immediately ends the session and interrupts whatever's playing (see
 *   `endConversation` in useVoiceChat).
 *
 * @param {Object} props
 * @param {import("../hooks/useVoiceChat").VoiceState} props.state
 * @param {boolean} props.handsFree Which mode is currently selected.
 * @param {() => void} props.onStartPushToTalk
 * @param {() => void} props.onStopPushToTalk
 * @param {() => void} props.onStartConversation
 * @param {() => void} props.onEndConversation
 */
export function MicButton({
  state,
  handsFree,
  onStartPushToTalk,
  onStopPushToTalk,
  onStartConversation,
  onEndConversation,
}) {
  const label = (handsFree ? HANDS_FREE_LABELS : PTT_LABELS)[state];

  const handleClick = () => {
    if (handsFree) {
      if (state === "idle") onStartConversation();
      else onEndConversation(); // tap at any point interrupts + ends the session
      return;
    }
    if (state === "idle") onStartPushToTalk();
    else if (state === "listening") onStopPushToTalk();
  };

  const disabled =
    !handsFree && (state === "transcribing" || state === "thinking" || state === "speaking");

  return (
    <div
      className={`mic-wrap${disabled ? " mic-wrap--disabled" : ""}`}
      onClick={disabled ? undefined : handleClick}
      role="button"
      aria-disabled={disabled}
      aria-label={label}
    >
      <SarjyAvatar state={state} audioLevel={0.7} />
      <p className="mic-label">{label}</p>
    </div>
  );
}