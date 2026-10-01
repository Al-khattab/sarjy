import { useCallback, useRef, useState } from "react";

function getUserId() {
  let id = localStorage.getItem("sarjy_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sarjy_user_id", id);
  }
  return id;
}

// Turn state machine: idle -> listening -> transcribing -> thinking -> speaking -> idle
// (or -> error at any point, which always returns to idle on the next mic press)
export function useVoiceChat() {
  const [state, setState] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [errorText, setErrorText] = useState(null);
  const [timings, setTimings] = useState(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioElRef = useRef(null);
  const userId = useRef(getUserId());

  const speak = useCallback(async (text) => {
    setState("speaking");
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("TTS request failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioElRef.current = audio;
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
    } catch {
      // Fallback: browser TTS, so the loop still completes even if the
      // Groq TTS call fails 
      await new Promise((resolve) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.onend = resolve;
        utter.onerror = resolve;
        window.speechSynthesis.speak(utter);
      });
    } finally {
      setState("idle");
    }
  }, []);

  const sendToChat = useCallback(
    async (userText) => {
      setState("thinking");
      setMessages((m) => [...m, { role: "user", content: userText }]);
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const localTimings = { turn_start: Date.now() };

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId.current,
        },
        body: JSON.stringify({ message: userText }),
      });

      if (!res.ok || !res.body) {
        setErrorText("Sarjy couldn't respond just now. Try again?");
        setState("idle");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

      // Minimal hand-rolled SSE parser — EventSource can't be used because
      // it only supports GET requests, and we need to send a POST body.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const raw of events) {
          const lines = raw.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.replace("event:", "").trim();
          const data = JSON.parse(dataLine.replace("data:", "").trim());

          if (event === "timing") {
            localTimings[data.name] = data.at;
            setTimings({ ...localTimings });
          } else if (event === "token") {
            full += data.text;
            setMessages((m) => {
              const copy = [...m];
              copy[copy.length - 1] = { role: "assistant", content: full };
              return copy;
            });
          } else if (event === "error") {
            setErrorText(data.message);
          }
        }
      }

      await speak(full);
    },
    [speak]
  );

  const startListening = useCallback(async () => {
    setErrorText(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", blob, "audio.webm");

        try {
          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok || !data.text) {
            setErrorText("Didn't catch that — mind trying again?");
            setState("idle");
            return;
          }
          await sendToChat(data.text);
        } catch {
          setErrorText("Transcription failed — check your connection.");
          setState("idle");
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setState("listening");
    } catch {
      setErrorText("Microphone access was denied. You can type instead below.");
      setState("idle");
    }
  }, [sendToChat]);

  const stopListening = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const sendTextFallback = useCallback(
    (text) => {
      sendToChat(text);
    },
    [sendToChat]
  );

  const forgetMe = useCallback(async () => {
    await fetch("/api/forget-me", {
      method: "POST",
      headers: { "x-user-id": userId.current },
    });
    setMessages([]);
  }, []);

  return {
    state,
    messages,
    errorText,
    timings,
    startListening,
    stopListening,
    sendTextFallback,
    forgetMe,
  };
}
