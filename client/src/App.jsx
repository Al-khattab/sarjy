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
    ttsProvider,
    setTtsProvider,
    ttsDebug,
    startConversation,
    endConversation,
    sendTextFallback,
    startListening,
    stopListening,
    forgetMe,
  } = useVoiceChat();

  const [typedText, setTypedText] = useState("");
  const [handsFreeMode, setHandsFreeMode] = useState(true);

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
          handsFree={handsFreeMode}
          onStartPushToTalk={startListening}
          onStopPushToTalk={stopListening}
          onStartConversation={startConversation}
          onEndConversation={endConversation}
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

      <div className="tts-toggle">
        <span>Mode:</span>
        <button
          className={handsFreeMode ? "active" : ""}
          onClick={() => setHandsFreeMode(true)}
          disabled={state !== "idle"}
        >
          Hands-free
        </button>
        <button
          className={!handsFreeMode ? "active" : ""}
          onClick={() => setHandsFreeMode(false)}
          disabled={state !== "idle"}
        >
          Push-to-talk
        </button>
      </div>

      <div className="tts-toggle">
        <span>Voice:</span>
        <button
          className={ttsProvider === "browser" ? "active" : ""}
          onClick={() => setTtsProvider("browser")}
          disabled={state !== "idle"}
        >
          Browser
        </button>
        <button
          className={ttsProvider === "groq" ? "active" : ""}
          onClick={() => setTtsProvider("groq")}
          disabled={state !== "idle"}
        >
          Groq
        </button>
        {ttsDebug && (
          <span className="tts-debug">
            {ttsDebug.provider}: {ttsDebug.roundTripMs}ms round trip
            {ttsDebug.synthesisMs != null &&
              ` (${ttsDebug.synthesisMs}ms synthesis)`}
          </span>
        )}
      </div>

      <footer className="footer">
        <LatencyPanel timings={timings} ttfa={ttfa} />
      </footer>
    </div>
  );
}
