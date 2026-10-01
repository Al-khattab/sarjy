import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groq, MODELS } from "./groq.js";

// Prototype-grade persistence: one JSON file on disk. This satisfies "remembers
// across sessions" for a single deployment/browser, but it will NOT survive a
// redeploy on most free hosts (the filesystem gets reset). Swap this module
// for Postgres (see PRD §13.2 — users/facts/messages tables) before relying
// on it for the real demo, or make sure your host has a persistent disk.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "memory.json");

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return { users: {} };
  }
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getUser(db, userId) {
  if (!db.users[userId]) {
    db.users[userId] = { facts: {}, messages: [] };
  }
  return db.users[userId];
}

export function getFacts(userId) {
  const db = readDb();
  return getUser(db, userId).facts;
}

export function appendMessage(userId, role, content) {
  const db = readDb();
  const user = getUser(db, userId);
  user.messages.push({ role, content, at: Date.now() });
  // keep the on-disk log bounded; the LLM only ever sees a recent slice anyway
  user.messages = user.messages.slice(-100);
  writeDb(db);
}

export function getRecentMessages(userId, limit = 12) {
  const db = readDb();
  return getUser(db, userId).messages.slice(-limit);
}

export function setFacts(userId, updates) {
  if (!updates || updates.length === 0) return;
  const db = readDb();
  const user = getUser(db, userId);
  for (const { key, value } of updates) {
    if (!key || !value) continue;
    user.facts[key] = value;
  }
  writeDb(db);
}

export function clearUser(userId) {
  const db = readDb();
  delete db.users[userId];
  writeDb(db);
}

/**
 * Cheap, separate LLM call: look at the latest exchange and pull out any new
 * durable facts about the user (name, preferences, etc.) as {key, value}
 * pairs. Runs after the main reply is sent so it never adds to perceived
 * latency. Kept intentionally small/fast — this is not the same model call
 * that generates the assistant's reply.
 */
export async function extractFacts(userMessage, assistantMessage) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODELS.chat,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "Extract durable personal facts/preferences the USER stated " +
            "about themselves from this exchange (e.g. name, favorite " +
            "color, city they live in). Ignore facts about anything else. " +
            'Respond ONLY with JSON: {"facts":[{"key":"favorite_color","value":"blue"}]}. ' +
            'If there is nothing new, respond {"facts":[]}. No prose.',
        },
        {
          role: "user",
          content: `User said: ${userMessage}\nAssistant replied: ${assistantMessage}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch (err) {
    console.warn("[sarjy] fact extraction skipped:", err.message);
    return [];
  }
}
