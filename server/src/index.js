import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeRouter } from "./routes/transcribe.js";
import { chatRouter } from "./routes/chat.js";
import { speakRouter } from "./routes/speak.js";
import { clearUser } from "./memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use("/api/transcribe", transcribeRouter);
app.use("/api/chat", chatRouter);
app.use("/api/speak", speakRouter);

app.post("/api/forget-me", (req, res) => {
  const userId = req.header("x-user-id");
  if (!userId) return res.status(400).json({ error: "Missing x-user-id header" });
  clearUser(userId);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Serve the built React app (run `npm run build` in /client first) so the
// whole thing is reachable from a single URL, per the PRD's deploy requirement.
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`[sarjy] server listening on http://localhost:${port}`);
});
