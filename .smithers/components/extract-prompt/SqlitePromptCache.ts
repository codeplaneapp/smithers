import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { CachedPrompt, PromptCache } from "./PromptCache";

export type SqlitePromptCacheOptions = {
  /** Path to the SQLite file. Default: `.smithers/cache/prompts.db`. */
  path?: string;
  /** Override the table name (useful for sharing a db file). */
  table?: string;
};

/**
 * SQLite-backed prompt cache. One row per key. Useful for high-volume
 * batch runs where one markdown file per prompt is unwieldy.
 */
export class SqlitePromptCache implements PromptCache {
  private readonly dbPath: string;
  private readonly table: string;
  private dbInstance: Database | undefined;

  constructor(opts: SqlitePromptCacheOptions = {}) {
    this.dbPath = resolve(opts.path ?? ".smithers/cache/prompts.db");
    this.table = opts.table ?? "extract_prompt_cache";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.table)) {
      throw new Error(`invalid table name: ${this.table}`);
    }
  }

  async get(key: string): Promise<CachedPrompt | undefined> {
    const db = await this.db();
    const row = db
      .query(`SELECT json FROM ${quotedTable(this.table)} WHERE key = ? LIMIT 1`)
      .get(key) as { json: string } | null;
    if (!row) return undefined;
    return { ...(JSON.parse(row.json) as CachedPrompt), key };
  }

  async set(key: string, value: CachedPrompt): Promise<void> {
    const db = await this.db();
    db.run(
      `INSERT INTO ${quotedTable(this.table)} (key, json, created_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET json = excluded.json, created_at_ms = excluded.created_at_ms`,
      [key, JSON.stringify({ ...value, key }), Date.now()],
    );
  }

  async delete(key: string): Promise<void> {
    const db = await this.db();
    db.run(`DELETE FROM ${quotedTable(this.table)} WHERE key = ?`, [key]);
  }

  async keys(): Promise<string[]> {
    const db = await this.db();
    const rows = db.query(`SELECT key FROM ${quotedTable(this.table)} ORDER BY key`).all() as { key: string }[];
    return rows.map((r) => r.key);
  }

  close(): void {
    this.dbInstance?.close();
    this.dbInstance = undefined;
  }

  private async db(): Promise<Database> {
    if (this.dbInstance) return this.dbInstance;
    if (!existsSync(dirname(this.dbPath))) {
      await mkdir(dirname(this.dbPath), { recursive: true });
    }
    const db = new Database(this.dbPath);
    db.run(`CREATE TABLE IF NOT EXISTS ${quotedTable(this.table)} (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`);
    this.dbInstance = db;
    return db;
  }
}

function quotedTable(table: string): string {
  return `"${table.replaceAll('"', '""')}"`;
}
