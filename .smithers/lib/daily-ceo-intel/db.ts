import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CoverageRow } from "./schemas";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS fingerprints (
    fingerprint TEXT PRIMARY KEY,
    src_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS seen_urls (
    url TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fetch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    retried INTEGER NOT NULL,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    issue_date_et TEXT PRIMARY KEY,
    delivered_at TEXT NOT NULL,
    kv_keys TEXT NOT NULL,
    delivery_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS source_reliability (
    source_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    total_fetches INTEGER NOT NULL DEFAULT 0,
    total_ok INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    last_ok_at TEXT,
    last_error_at TEXT,
    last_error TEXT
  )`,
];

export type CeoIntelDb = Database;

export function openDb(dbPath: string): { db: CeoIntelDb; schemaCreated: boolean } {
  // Guarded: bun on Windows throws EEXIST for a recursive mkdir of an
  // existing "." (the dirname of a bare relative filename).
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  let schemaCreated = isNew;
  const existing = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='fingerprints'").get();
  if (!existing) schemaCreated = true;
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  return { db, schemaCreated };
}

export function recordFetchHistory(db: CeoIntelDb, runAt: string, rows: CoverageRow[]): void {
  const insert = db.prepare(
    `INSERT INTO fetch_history (run_at, source_id, kind, ok, item_count, retried, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertReliability = db.prepare(`
    INSERT INTO source_reliability (source_id, kind, total_fetches, total_ok, total_items, last_ok_at, last_error_at, last_error)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      total_fetches = total_fetches + 1,
      total_ok = total_ok + excluded.total_ok,
      total_items = total_items + excluded.total_items,
      last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
      last_error_at = COALESCE(excluded.last_error_at, last_error_at),
      last_error = COALESCE(excluded.last_error, last_error)
  `);
  const tx = db.transaction((items: CoverageRow[]) => {
    for (const row of items) {
      insert.run(runAt, row.sourceId, row.kind, row.ok ? 1 : 0, row.itemCount, row.retried ? 1 : 0, row.error);
      upsertReliability.run(
        row.sourceId,
        row.kind,
        row.ok ? 1 : 0,
        row.itemCount,
        row.ok ? runAt : null,
        row.ok ? null : runAt,
        row.ok ? null : row.error,
      );
    }
  });
  tx(rows);
}

export function lookupFingerprint(db: CeoIntelDb, fingerprint: string): { contentHash: string } | null {
  const row = db
    .query("SELECT content_hash as contentHash FROM fingerprints WHERE fingerprint = ?")
    .get(fingerprint) as { contentHash: string } | null;
  return row ?? null;
}

export function upsertFingerprint(
  db: CeoIntelDb,
  fingerprint: string,
  srcId: string,
  canonicalUrl: string,
  contentHash: string,
  nowIso: string,
): void {
  db.run(
    `INSERT INTO fingerprints (fingerprint, src_id, canonical_url, content_hash, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       content_hash = excluded.content_hash,
       last_seen_at = excluded.last_seen_at`,
    [fingerprint, srcId, canonicalUrl, contentHash, nowIso, nowIso],
  );
}

export function upsertSeenUrl(db: CeoIntelDb, url: string, nowIso: string): void {
  db.run(`INSERT INTO seen_urls (url, first_seen_at) VALUES (?, ?) ON CONFLICT(url) DO NOTHING`, [url, nowIso]);
}

export function pruneFingerprints(db: CeoIntelDb, retentionDays: number, nowIso: string): number {
  const cutoffMs = Date.parse(nowIso) - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const result = db.run("DELETE FROM fingerprints WHERE last_seen_at < ?", [cutoffIso]);
  return Number(result.changes ?? 0);
}

export function getDelivery(db: CeoIntelDb, issueDateEt: string): { kvKeys: string[]; deliveryId: string } | null {
  const row = db
    .query("SELECT kv_keys as kvKeys, delivery_id as deliveryId FROM deliveries WHERE issue_date_et = ?")
    .get(issueDateEt) as { kvKeys: string; deliveryId: string } | null;
  if (!row) return null;
  return { kvKeys: JSON.parse(row.kvKeys) as string[], deliveryId: row.deliveryId };
}

export function recordDelivery(
  db: CeoIntelDb,
  issueDateEt: string,
  deliveredAt: string,
  kvKeys: string[],
  deliveryId: string,
): void {
  db.run(
    `INSERT INTO deliveries (issue_date_et, delivered_at, kv_keys, delivery_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(issue_date_et) DO UPDATE SET
       delivered_at = excluded.delivered_at,
       kv_keys = excluded.kv_keys,
       delivery_id = excluded.delivery_id`,
    [issueDateEt, deliveredAt, JSON.stringify(kvKeys), deliveryId],
  );
}
