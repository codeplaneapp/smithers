import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { forkRun, getBranchInfo, listBranches } from "@smithers-orchestrator/time-travel/fork";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

setDefaultTimeout(120_000);

/** @type {string[]} */
const tempDirs = [];

function makeWorkspace(name) {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

async function closeApi(api) {
  await api?.close?.();
  api?.db?.$client?.close?.();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedSqliteStore(cwd) {
  const dbPath = join(cwd, "smithers.db");
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
    INSERT INTO _smithers_snapshots (run_id, frame_no, nodes_json, outputs_json, ralph_json, input_json, content_hash, created_at_ms)
      VALUES ('run-migrate-1', 1, '[]', '{}', '{}', '{"prompt":"hello"}', 'hash-1', 20);
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

async function tableCount(pgConn, table) {
  const rows = await pgConn.query({ text: `SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"` });
  return Number(rows.rows[0].count);
}

function quoteId(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function listSourceTables(sqlite) {
  return sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function sourceColumns(sqlite, table) {
  return sqlite
    .query(`PRAGMA table_info(${quoteId(table)})`)
    .all()
    .map((row) => row.name);
}

// Storage is mirrored (booleans in BIGINT, blobs in BYTEA, JSON in TEXT) and
// node-postgres returns BIGINT as a string unless coerced, so normalize each
// value to a dialect-independent shape before comparing source vs target rows.
function normalizeCell(value) {
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

function canonicalRows(rows, columns) {
  return rows
    .map((row) => JSON.stringify(columns.map((column) => normalizeCell(row[column]))))
    .sort();
}

// Compare EVERY row of EVERY source table against the migrated target,
// column-for-column, proving a faithful row-for-row copy (not just counts).
async function assertRowForRowEquality(sourceDbPath, pgConn) {
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

describe("migrateSmithersStore", () => {
  test("copies a SQLite Smithers store to PGlite row-for-row and writes migrated.json", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite");
    const dbPath = seedSqliteStore(cwd);
    const progress = [];

    const result = await migrateSmithersStore({
      cwd,
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result.backend).toBe("pglite");
    expect(result.dbPath).toBe(dbPath);
    expect(result.runCount).toBe(1);
    expect(result.schemaVersion).toBe("0017");
    expect(existsSync(result.markerPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(progress.some((event) => event.type === "table-copied" && event.table === "result")).toBe(true);
    for (const table of result.tables) {
      expect(table.targetRows).toBe(table.sourceRows);
    }

    const api = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      const pgConn = api.db.connection;
      expect(await tableCount(pgConn, "_smithers_runs")).toBe(1);
      expect(await tableCount(pgConn, "_smithers_snapshots")).toBe(1);
      expect(await tableCount(pgConn, "_smithers_node_diffs")).toBe(1);
      expect(await tableCount(pgConn, "_smithers_vectors")).toBe(1);
      expect(await tableCount(pgConn, "result")).toBe(1);
      const output = await pgConn.query({ text: 'SELECT run_id, node_id, iteration, value, ok FROM "result"' });
      expect(output.rows).toEqual([
        {
          run_id: "run-migrate-1",
          node_id: "write-result",
          iteration: 0,
          value: 42,
          ok: 1,
        },
      ]);
      const inputColumns = await pgConn.query({
        text: "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'input' ORDER BY ordinal_position",
      });
      expect(inputColumns.rows.map((row) => row.column_name)).toEqual(["run_id", "prompt"]);
      const vector = await pgConn.query({ text: "SELECT dimensions, embedding FROM _smithers_vectors" });
      expect(vector.rows[0].dimensions).toBe(4);
      expect(Buffer.from(vector.rows[0].embedding).toString("hex")).toBe("01020304");
    } finally {
      await closeApi(api);
    }
  });

  test("migrates every row of every table row-for-row and yields a replayable (fork/time-travel) run on the target", async () => {
    const cwd = makeWorkspace("smithers-migrate-roundtrip");
    const dbPath = seedSqliteStore(cwd);

    const result = await migrateSmithersStore({ cwd });
    // Copy-only by default: the source store is left intact for rollback.
    expect(result.sqliteRemoved).toBe(false);
    expect(existsSync(dbPath)).toBe(true);

    const api = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      const pgConn = api.db.connection;

      // 1. Row-for-row equality across every migrated table.
      await assertRowForRowEquality(dbPath, pgConn);

      // 2. The migrated snapshot is replayable: fork the run from its frame on
      //    the PGlite target and confirm the branched run + lineage persisted.
      const adapter = new SmithersDb(api.db);
      const fork = await forkRun(adapter, {
        parentRunId: "run-migrate-1",
        frameNo: 1,
        branchLabel: "replay-after-migrate",
      });
      expect(fork.runId).toBeTruthy();
      expect(fork.runId).not.toBe("run-migrate-1");

      const childRun = await adapter.getRun(fork.runId);
      expect(childRun?.parentRunId).toBe("run-migrate-1");

      const branches = await listBranches(adapter, "run-migrate-1");
      expect(branches.map((branch) => branch.runId)).toContain(fork.runId);

      const branchInfo = await getBranchInfo(adapter, fork.runId);
      expect(branchInfo?.parentRunId).toBe("run-migrate-1");
      expect(branchInfo?.parentFrameNo).toBe(1);

      // The forked snapshot carries the migrated input forward (frame 0 of the
      // child), proving the time-travel checkpoint survived the migration.
      const childSnapshot = await pgConn.query({
        text: 'SELECT input_json FROM _smithers_snapshots WHERE run_id = $1 AND frame_no = 0',
        values: [fork.runId],
      });
      expect(JSON.parse(childSnapshot.rows[0].input_json)).toEqual({ prompt: "hello" });
    } finally {
      await closeApi(api);
    }
  });

  test("can remove sqlite files only after a successful copy", async () => {
    const cwd = makeWorkspace("smithers-migrate-remove-sqlite");
    const dbPath = seedSqliteStore(cwd);

    const result = await migrateSmithersStore({ cwd, keepSqlite: false });

    expect(result.sqliteRemoved).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(result.markerPath)).toBe(true);
  });
});
