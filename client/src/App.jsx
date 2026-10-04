import { useState } from "react";
import { useVoiceChat } from "./hooks/useVoiceChat.js";
import { Transcript } from "./components/Transcript.jsx";
import { LatencyPanel } from "./components/LatencyPanel.jsx";
import { MicButton } from "./components/MicButton.jsx";

export default function App() {
  const {
    state,
    messages,
    errorText,
    timings,
    ttfa,
    startListening,
    stopListening,
    sendTextFallback,
    forgetMe,
  } = useVoiceChat();

  const [typedText, setTypedText] = useState("");

  const micDenied = errorText?.includes("Microphone access");

  return (
    <div className="page">
      <header className="header">
        <span className="wordmark">سرج · Sarjy</span>
        <button className="forget-link" onClick={forgetMe}>
          Forget me
        </button>
      </header>

      <main className="main">
        <MicButton
          state={state}
          onStart={startListening}
          onStop={stopListening}
        />

        {errorText && (
          <div className="banner banner--error" role="alert">
            {errorText}
          </div>
        )}

        {micDenied && (
          <form
            className="fallback-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typedText.trim()) return;
              sendTextFallback(typedText.trim());
              setTypedText("");
            }}
          >
            <input
              className="chat__input"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder="Type instead…"
            />
            <button type="submit">Send</button>
          </form>
        )}

        <div className="chat">
          <Transcript messages={messages} />
        </div>
      </main>

      <footer className="footer">
        <LatencyPanel timings={timings} ttfa={ttfa} />
      </footer>
    </div>
  );
}
