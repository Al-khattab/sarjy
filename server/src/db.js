import { Pool } from "pg";

if (!process.env.DB_URL) {
    console.warn(
      "[sarjy] DB_URL is not set — memory will fail until you add a " +
        "Neon/Postgres connection string to server/.env"
    );
  }

export const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: process.env.DB_URL?.includes("sslmode=require")
    ? undefined // already specified in the connection string
    : { rejectUnauthorized: false },
});


async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS facts (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, key)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS messages_user_id_created_at_idx
        ON messages (user_id, created_at);
    `);
  }
  
  // Run once at import time. Any route awaiting the pool's first query
  // naturally waits behind this — it's a couple of fast DDL statements, so it
  // only costs real time on the very first request after a cold start.
  export const schemaReady = ensureSchema().catch((err) => {
    console.error("[sarjy] failed to create schema:", err.message);
  });