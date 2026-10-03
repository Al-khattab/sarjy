import { groq, MODELS } from "./groq.js";
import { pool, schemaReady } from "./db.js";


export async function getFacts(userId) {
  await schemaReady;
  const { rows } = await pool.query(
    "SELECT key, value FROM facts WHERE user_id = $1",
    [userId]
  )
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function appendMessage(userId, role, content) {
  await schemaReady;
  await pool.query(
    "INSERT INTO messages (user_id, role, content) VALUES ($1, $2, $3)",
    [userId, role, content]
  );
}

export async function getRecentMessages(userId, limit = 12) {
  await schemaReady;
  const { rows } = await pool.query(
    `SELECT role, content FROM messages
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]);
    return rows.reverse(); 
}

export async function setFacts(userId, updates) {
  if (!updates || updates.length === 0) return;
  await schemaReady;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { key, value } of updates) {
      if (!key || !value) continue;
      await client.query(
        `INSERT INTO facts (user_id, key, value, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [userId, key, value]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function clearUser(userId) {
  await schemaReady;
  await pool.query("DELETE FROM facts WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM messages WHERE user_id = $1", [userId]);
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
