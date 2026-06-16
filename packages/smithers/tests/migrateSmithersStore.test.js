import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
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
    expect(result.schemaVersion).toBe("0016");
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

  test("can remove sqlite files only after a successful copy", async () => {
    const cwd = makeWorkspace("smithers-migrate-remove-sqlite");
    const dbPath = seedSqliteStore(cwd);

    const result = await migrateSmithersStore({ cwd, keepSqlite: false });

    expect(result.sqliteRemoved).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(result.markerPath)).toBe(true);
  });
});
