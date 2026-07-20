import type { D1Database } from "./env.ts";

const statements = [
  `CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    update_id INTEGER PRIMARY KEY,
    chat_id TEXT,
    message_id INTEGER,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    at_ms INTEGER,
    url TEXT,
    raw_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_at_idx ON messages(at_ms)`,
  `CREATE INDEX IF NOT EXISTS messages_chat_at_idx ON messages(chat_id, at_ms)`,
  `CREATE TABLE IF NOT EXISTS digests (
    id TEXT PRIMARY KEY,
    period_start_ms INTEGER NOT NULL,
    period_end_ms INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    model TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    telegram_text TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    posted_at_ms INTEGER,
    post_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS digests_created_idx ON digests(created_at_ms DESC)`,
];

export async function ensureSchema(db: D1Database): Promise<void> {
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}
