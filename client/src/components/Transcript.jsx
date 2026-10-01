export function Transcript({ messages }) {
  if (messages.length === 0) {
    return (
      <div className="transcript transcript--empty">
        <p>
          Try: <em>&ldquo;My favorite color is teal.&rdquo;</em> Then, later,{" "}
          <em>&ldquo;What&rsquo;s my favorite color?&rdquo;</em>
        </p>
        <p>
          Or: <em>&ldquo;What&rsquo;s the weather in Dubai right now?&rdquo;</em>
        </p>
      </div>
    );
  }

  return (
    <div className="transcript">
      {messages.map((m, i) => (
        <div key={i} className={`bubble bubble--${m.role}`}>
          <span className="bubble__role">{m.role === "user" ? "You" : "Sarjy"}</span>
          <p>{m.content || "…"}</p>
        </div>
      ))}
    </div>
  );
}
