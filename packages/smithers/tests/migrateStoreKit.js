// Shared fixtures for the migrate-store suites. The suites are split into
// separate files so CI can run each in its own bun process: every PGlite
// instance holds >1GB of WASM memory bun cannot reliably reclaim, and the
// whole suite in one process dies with a Bus error near the ~2GB ceiling.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SmithersDb } from "../../db/src/adapter.js";
import { ensureSmithersTables } from "../../db/src/ensure.js";
import { forkRun, getBranchInfo, listBranches } from "@smithers-orchestrator/time-travel/fork";
import { loadSnapshot } from "@smithers-orchestrator/time-travel/snapshot";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import pg from "pg";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { createSmithersPostgres } from "../src/create.js";
import { openSmithersStore } from "../src/openSmithersStore.js";
import { resolveSmithersBackendChoice } from "../src/resolveSmithersBackendChoice.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

setDefaultTimeout(120_000);

/** @type {string[]} */
export const tempDirs = [];
export const PG_URL = process.env.SMITHERS_TEST_PG_URL;

export function makeWorkspace(name) {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

export async function closeApi(api) {
  await api?.close?.();
  api?.db?.$client?.close?.();
  // Reclaim the closed PGlite's WASM memory immediately: with several
  // multi-extension instances per test, lazy collection lets mapped WASM
  // regions stack up until bun dies with a Bus error near 2GB.
  Bun.gc(true);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Every test boots at least one PGlite (WASM) instance; without a forced
  // collection between tests the mapped WASM memories accumulate until bun
  // dies with a Bus error near the 2GB mark (reproducible from ~3 tests in).
  Bun.gc(true);
});

export function seedSqliteStore(cwd, dbPath = join(cwd, "smithers.db")) {
  const api = createSmithers({
    input: z.object({ prompt: z.string().nullable() }),
    result: z.object({
      value: z.number().int(),
      ok: z.boolean(),
    }),
  }, { dbPath, backend: "sqlite" });
  ensureSmithersTables(api.db);
  const sqlite = api.db.$client;
  sqlite.exec(`
    INSERT INTO input (run_id, prompt)
      VALUES ('run-migrate-1', 'hello');
    INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms, started_at_ms, finished_at_ms)
      VALUES ('run-migrate-1', 'migration-fixture', '.smithers/workflows/migration-fixture.tsx', 'finished', 10, 11, 20);
    INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
      VALUES ('run-migrate-1', 'write-result', 0, 'finished', 1, 20, 'result', 'Write result');
    INSERT INTO _smithers_attempts (run_id, node_id, iteration, attempt, state, started_at_ms, finished_at_ms, cached)
      VALUES ('run-migrate-1', 'write-result', 0, 1, 'finished', 12, 19, 0);
    INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
      VALUES ('run-migrate-1', 1, 12, 'RunStarted', '{"runId":"run-migrate-1"}');
    INSERT INTO _smithers_snapshot_contents (content_hash, nodes_json, outputs_json, ralph_json, input_json, ref_count)
      VALUES ('hash-1', '[]', '{}', '{}', '{"prompt":"hello"}', 0);
    INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms)
      VALUES ('run-migrate-1', 1, '', '', '', '', 'hash-1', 20);
    INSERT INTO _smithers_snapshot_payload_refs (run_id, frame_no, content_hash)
      VALUES ('run-migrate-1', 1, 'hash-1');
    INSERT INTO _smithers_node_diffs (run_id, node_id, iteration, base_ref, diff_json, computed_at_ms, size_bytes)
      VALUES ('run-migrate-1', 'write-result', 0, 'base', '{"files":[]}', 21, 12);
    INSERT INTO _smithers_vectors (id, namespace, content, embedding, dimensions, metadata_json, document_id, chunk_index, created_at_ms)
      VALUES ('vec-1', 'test', 'chunk', X'01020304', 4, '{}', 'doc-1', 0, 22);
    INSERT INTO result (run_id, node_id, iteration, value, ok)
      VALUES ('run-migrate-1', 'write-result', 0, 42, 1);
  `);
  api.db.$client.close();
  return dbPath;
}

export function seedOlderSqliteStore(cwd) {
  const dbPath = join(cwd, "smithers.db");
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE _smithers_frames (
      run_id TEXT NOT NULL,
      frame_no INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      xml_json TEXT NOT NULL,
      xml_hash TEXT NOT NULL,
      PRIMARY KEY (run_id, frame_no)
    );
    CREATE TABLE _smithers_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
      VALUES ('run-old-1', 'old-workflow', 'finished', 100);
    INSERT INTO _smithers_frames (run_id, frame_no, created_at_ms, xml_json, xml_hash)
      VALUES ('run-old-1', 0, 101, '{"kind":"element"}', 'hash-old');
    INSERT INTO _smithers_events (run_id, seq, type, payload_json)
      VALUES ('run-old-1', 1, 'RunStarted', '{"runId":"run-old-1"}');
  `);
  sqlite.close();
  return dbPath;
}

export async function tableCount(pgConn, table) {
  const rows = await pgConn.query({ text: `SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"` });
  return Number(rows.rows[0].count);
}

export function quoteId(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function tempPgDatabaseName(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function pgUrlForDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withTempPostgresDatabase(prefix, fn) {
  const database = tempPgDatabaseName(prefix);
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteId(database)}`);
  await admin.end();

  const url = pgUrlForDatabase(PG_URL, database);
  try {
    return await fn(url);
  } finally {
    const cleanup = new pg.Client({ connectionString: PG_URL });
    await cleanup.connect();
    await cleanup.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    ).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS ${quoteId(database)}`).catch(() => {});
    await cleanup.end().catch(() => {});
  }
}

export function listSourceTables(sqlite) {
  return sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

export function sourceColumns(sqlite, table) {
  return sqlite
    .query(`PRAGMA table_info(${quoteId(table)})`)
    .all()
    .map((row) => row.name);
}

// Storage is mirrored (booleans in BIGINT, blobs in BYTEA, JSON in TEXT) and
// node-postgres returns BIGINT as a string unless coerced, so normalize each
// value to a dialect-independent shape before comparing source vs target rows.
export function normalizeCell(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(value))) {
    return `blob:${Buffer.from(value).toString("hex")}`;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

export function canonicalRows(rows, columns) {
  return rows
    .map((row) => JSON.stringify(columns.map((column) => normalizeCell(row[column]))))
    .sort();
}

// Compare EVERY row of EVERY source table against the migrated target,
// column-for-column, proving a faithful row-for-row copy (not just counts).
export async function assertRowForRowEquality(sourceDbPath, pgConn) {
  const sqlite = new Database(sourceDbPath, { readonly: true });
  try {
    const tables = listSourceTables(sqlite);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const columns = sourceColumns(sqlite, table);
      if (columns.length === 0) {
        continue;
      }
      const columnSql = columns.map(quoteId).join(", ");
      const sourceRows = sqlite.query(`SELECT ${columnSql} FROM ${quoteId(table)}`).all();
      const target = await pgConn.query({ text: `SELECT ${columnSql} FROM ${quoteId(table)}` });
      expect({ table, rows: canonicalRows(target.rows, columns) }).toEqual({
        table,
        rows: canonicalRows(sourceRows, columns),
      });
    }
  } finally {
    sqlite.close();
  }
}

export async function seedPgliteStore(cwd) {
  const sqliteSourcePath = seedSqliteStore(cwd);
  await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
  rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
  rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
  return sqliteSourcePath;
}

// Like seedPgliteStore, but PRESERVES the migrated.json / backend.json receipts
// the migration writes so reverse-inference can read them. With keepSqlite:false
// the leftover root smithers.db is removed; with keepSqlite:true it stays.
export async function seedPgliteStoreWithReceipt(cwd, { keepSqlite = false } = {}) {
  const sqliteSourcePath = seedSqliteStore(cwd);
  await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite });
  return sqliteSourcePath;
}

export function sqliteRunIds(dbPath) {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.query("SELECT run_id FROM _smithers_runs ORDER BY run_id").all().map((row) => row.run_id);
  } finally {
    sqlite.close();
  }
}

export function assertSqlitePrimaryKeyAndDuplicateRejection(dbPath) {
  const sqlite = new Database(dbPath);
  try {
    const primaryKeyColumns = sqlite
      .query("PRAGMA table_info(_smithers_runs)")
      .all()
      .filter((row) => Number(row.pk) > 0)
      .map((row) => row.name);
    expect(primaryKeyColumns).toEqual(["run_id"]);
    expect(sqlite.query("PRAGMA index_list(_smithers_runs)").all().length).toBeGreaterThan(0);
    expect(() => {
      sqlite
        .query("INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms) VALUES (?, ?, ?, ?, ?)")
        .run("run-migrate-1", "dup", "dup.tsx", "finished", 99);
    }).toThrow();
  } finally {
    sqlite.close();
  }
}


// Index-based chunking so CI can run slices of a migrate suite in separate
// bun processes (see the header comment). Without SMITHERS_MIGRATE_CHUNKS
// every test runs; with it, out-of-chunk tests report as skipped so a
// mis-set chunk count is visible, never a silent coverage loss.
const MIGRATE_CHUNKS = Number(process.env.SMITHERS_MIGRATE_CHUNKS ?? "0");
const MIGRATE_CHUNK = Number(process.env.SMITHERS_MIGRATE_CHUNK ?? "0");
let chunkTestIndex = 0;
export function chunkedTest(name, fn, timeoutOrOptions) {
  const index = chunkTestIndex++;
  const runsHere = !MIGRATE_CHUNKS || index % MIGRATE_CHUNKS === MIGRATE_CHUNK;
  (runsHere ? test : test.skip)(name, fn, timeoutOrOptions);
}
