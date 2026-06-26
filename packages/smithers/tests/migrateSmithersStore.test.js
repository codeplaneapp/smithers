import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SmithersDb } from "../../db/src/adapter.js";
import { ensureSmithersTables } from "../../db/src/ensure.js";
import { forkRun, getBranchInfo, listBranches } from "@smithers-orchestrator/time-travel/fork";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import pg from "pg";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { createSmithersPostgres } from "../src/create.js";
import { openSmithersStore } from "../src/openSmithersStore.js";
import { resolveSmithersBackendChoice } from "../src/resolveSmithersBackendChoice.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

setDefaultTimeout(120_000);

/** @type {string[]} */
const tempDirs = [];
const PG_URL = process.env.SMITHERS_TEST_PG_URL;

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

function seedSqliteStore(cwd, dbPath = join(cwd, "smithers.db")) {
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

function seedOlderSqliteStore(cwd) {
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

async function tableCount(pgConn, table) {
  const rows = await pgConn.query({ text: `SELECT COUNT(*) AS count FROM "${table.replaceAll('"', '""')}"` });
  return Number(rows.rows[0].count);
}

function quoteId(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tempPgDatabaseName(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function pgUrlForDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withTempPostgresDatabase(prefix, fn) {
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

async function seedPgliteStore(cwd) {
  const sqliteSourcePath = seedSqliteStore(cwd);
  await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
  rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
  rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
  return sqliteSourcePath;
}

function sqliteRunIds(dbPath) {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.query("SELECT run_id FROM _smithers_runs ORDER BY run_id").all().map((row) => row.run_id);
  } finally {
    sqlite.close();
  }
}

function assertSqlitePrimaryKeyAndDuplicateRejection(dbPath) {
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

describe("migrateSmithersStore", () => {
  test("copies a SQLite Smithers store to PGlite row-for-row and writes migrated.json", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite");
    const dbPath = seedSqliteStore(cwd);
    const progress = [];

    const result = await migrateSmithersStore({
      cwd,
      to: "pglite",
      onProgress(event) {
        progress.push(event);
      },
    });

    expect(result.backend).toBe("pglite");
    expect(result.dbPath).toBe(dbPath);
    expect(result.runCount).toBe(1);
    expect(result.schemaVersion).toBe("0018");
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

  test("infers nested .smithers/smithers.db as the SQLite source when it has runs", async () => {
    const cwd = makeWorkspace("smithers-migrate-nested-sqlite");
    const nestedDbPath = seedSqliteStore(cwd, join(cwd, ".smithers", "smithers.db"));

    const result = await migrateSmithersStore({ cwd, to: "pglite" });

    expect(result.backend).toBe("pglite");
    expect(result.dbPath).toBe(nestedDbPath);
    expect(result.runCount).toBe(1);

    const api = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      const pgConn = api.db.connection;
      expect(await tableCount(pgConn, "_smithers_runs")).toBe(1);
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
    } finally {
      await closeApi(api);
    }
  });

  test("migrates every row of every table row-for-row and yields a replayable (fork/time-travel) run on the target", async () => {
    const cwd = makeWorkspace("smithers-migrate-roundtrip");
    const dbPath = seedSqliteStore(cwd);

    const result = await migrateSmithersStore({ cwd, to: "pglite" });
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

  test("rejects with an actionable SmithersError when the source store is corrupt, leaving no partial output", async () => {
    const cwd = makeWorkspace("smithers-migrate-corrupt");
    const dbPath = join(cwd, "smithers.db");
    // A file that is not a valid SQLite store: bun:sqlite fails to read it with
    // a "not a database" / "malformed" style error when migrate opens it.
    writeFileSync(dbPath, "this is not a sqlite database at all", "utf8");

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "pglite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_QUERY_FAILED");
    expect(caught.message).toContain(dbPath);
    expect(caught.message).toContain("corrupt");
    expect(caught.message).toContain("PRAGMA integrity_check");
    expect(caught.message).toContain("left untouched");
    expect(caught.message).toContain("smithers migrate --from sqlite --to pglite");
    expect(caught.message).not.toContain("is not defined");
    // The original bun:sqlite error is preserved as the cause/details.
    expect(caught.details).toEqual({ dbPath });
    expect(caught.cause).toBeDefined();

    // No partial write: neither the PGlite store nor the migrated.json marker
    // should exist, and the corrupt source file is left untouched.
    expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
  });

  test("rejects with an actionable SmithersError when the source store cannot be opened, leaving no partial output", async () => {
    const cwd = makeWorkspace("smithers-migrate-unopenable");
    const dbPath = join(cwd, "smithers.db");
    // A file that exists but cannot be opened (no read permission) makes
    // bun:sqlite fail with "unable to open database file" — distinct from a
    // corrupt store. This also covers the missing -wal/-shm sidecar case.
    writeFileSync(dbPath, "placeholder", "utf8");
    chmodSync(dbPath, 0o000);

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "pglite" });
    } catch (error) {
      caught = error;
    } finally {
      chmodSync(dbPath, 0o600); // restore so afterEach can clean up
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_QUERY_FAILED");
    expect(caught.message).toContain(dbPath);
    expect(caught.message.toLowerCase()).toContain("could not open");
    expect(caught.message).toContain("-wal");
    expect(caught.message).toContain("left untouched");
    expect(caught.message).toContain("smithers migrate --from sqlite --to pglite");
    expect(caught.message).not.toContain("is not defined");
    expect(caught.details).toEqual({ dbPath });
    expect(caught.cause).toBeDefined();
    expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
  });

  test("migrate --to postgres with no url fails with INVALID_INPUT before opening the source (not masked)", async () => {
    const cwd = makeWorkspace("smithers-migrate-pg-nourl");
    const dbPath = join(cwd, "smithers.db");
    // Even with an UNOPENABLE source, the missing-url validation must win, so
    // the user sees the actionable url guidance rather than a source-open error.
    writeFileSync(dbPath, "placeholder", "utf8");
    chmodSync(dbPath, 0o000);

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "postgres", env: {} });
    } catch (error) {
      caught = error;
    } finally {
      chmodSync(dbPath, 0o600);
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("INVALID_INPUT");
    expect(caught.message).toContain("SMITHERS_POSTGRES_URL");
    expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
  });

  test("can remove sqlite files only after a successful copy", async () => {
    const cwd = makeWorkspace("smithers-migrate-remove-sqlite");
    const dbPath = seedSqliteStore(cwd);
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL; INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES ('run-migrate-1', 2, 23, 'SidecarSeed', '{}');");
    sqlite.close();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    const result = await migrateSmithersStore({ cwd, to: "pglite", keepSqlite: false });

    expect(result.sqliteRemoved).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(result.markerPath)).toBe(true);
  });

  test("copies a PGlite Smithers store back to SQLite row-for-row and writes both receipts after verification", async () => {
    const cwd = makeWorkspace("smithers-migrate-pglite-to-sqlite");
    const originalSqlite = await seedPgliteStore(cwd);
    rmSync(originalSqlite, { force: true });
    expect(existsSync(originalSqlite)).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);

    const result = await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });

    expect(result.backend).toBe("sqlite");
    expect(result.source.backend).toBe("pglite");
    expect(result.runCount).toBe(1);
    expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(true);
    expect(JSON.parse(await Bun.file(join(cwd, ".smithers", "backend.json")).text())).toMatchObject({ backend: "sqlite" });
    expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
    const marker = JSON.parse(readFileSync(join(cwd, ".smithers", "migrated.json"), "utf8"));
    expect(marker.source).toMatchObject({ backend: "pglite", dataDir: join(cwd, ".smithers", "pg") });
    expect(marker.source.dbPath).toBeUndefined();

    const writableSqlite = new Database(join(cwd, "smithers.db"));
    try {
      const tableDdl = writableSqlite
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_smithers_runs'")
        .get().sql;
      expect(tableDdl).toContain("PRIMARY KEY");
      const primaryKeyColumns = writableSqlite
        .query("PRAGMA table_info(_smithers_runs)")
        .all()
        .filter((row) => Number(row.pk) > 0)
        .map((row) => row.name);
      expect(primaryKeyColumns).toEqual(["run_id"]);
      const indexCount = writableSqlite.query("PRAGMA index_list(_smithers_runs)").all().length;
      expect(indexCount).toBeGreaterThan(0);
      expect(() => {
        writableSqlite
          .query("INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms) VALUES (?, ?, ?, ?, ?)")
          .run("run-migrate-1", "dup", "dup.tsx", "finished", 99);
      }).toThrow();
    } finally {
      writableSqlite.close();
    }

    // Open the PGlite source directly: the migrated SQLite store now sits
    // beside it, so the resolver correctly refuses to disambiguate.
    const sourceApi = await createSmithersPostgres({}, { provider: "pglite", dataDir: join(cwd, ".smithers", "pg") });
    try {
      const sqlite = new Database(join(cwd, "smithers.db"), { readonly: true });
      try {
        const tables = listSourceTables(sqlite);
        for (const table of tables) {
          const sourceCount = await tableCount(sourceApi.db.connection, table);
          const targetCount = sqlite.query(`SELECT COUNT(*) AS count FROM ${quoteId(table)}`).get().count;
          expect({ table, targetCount }).toEqual({ table, targetCount: sourceCount });
        }
      } finally {
        sqlite.close();
      }
    } finally {
      await closeApi(sourceApi);
    }
  });

  test("infers --from when exactly one backend store has runs and refuses ambiguous populated stores", async () => {
    const pgliteOnly = makeWorkspace("smithers-migrate-infer-pglite");
    const originalSqlite = await seedPgliteStore(pgliteOnly);
    rmSync(originalSqlite, { force: true });

    const inferred = await migrateSmithersStore({ cwd: pgliteOnly, to: "sqlite" });
    expect(inferred.source.backend).toBe("pglite");
    expect(sqliteRunIds(join(pgliteOnly, "smithers.db"))).toEqual(["run-migrate-1"]);

    const ambiguous = makeWorkspace("smithers-migrate-ambiguous");
    await seedPgliteStore(ambiguous);
    await expect(migrateSmithersStore({ cwd: ambiguous, to: "sqlite" })).rejects.toMatchObject({
      code: "SMITHERS_BACKEND_CONFLICT",
    });
  });

  test("refuses to merge into a non-empty SQLite target and does not write receipts", async () => {
    const cwd = makeWorkspace("smithers-migrate-nonempty-sqlite-target");
    const sourceDbPath = await seedPgliteStore(cwd);
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
    seedSqliteStore(cwd, sourceDbPath);

    await expect(migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" })).rejects.toMatchObject({
      code: "DB_WRITE_FAILED",
    });
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  test("deterministic migration failures include exact agent fallback guidance and keep receipts absent", async () => {
    const cwd = makeWorkspace("smithers-migrate-agent-guidance");
    await seedPgliteStore(cwd);
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });
    seedSqliteStore(cwd, join(cwd, "smithers.db"));

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.message).toContain("smithers migrate --from pglite --to sqlite");
    expect(caught.message).toContain("Agent-assisted repair is tracked as a follow-up");
    expect(caught.message).not.toContain("is not defined");
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  test("forward sqlite to pglite failures include agent fallback guidance and keep receipts absent", async () => {
    const cwd = makeWorkspace("smithers-migrate-forward-agent-guidance");
    const targetApi = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      await targetApi.db.connection.query({
        text: "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms) VALUES ($1, $2, $3, $4, $5)",
        values: ["target-run", "existing", "existing.tsx", "finished", 1],
      });
    } finally {
      await closeApi(targetApi);
    }
    seedSqliteStore(cwd);

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.message).toContain("smithers migrate --from sqlite --to pglite");
    expect(caught.message).toContain("Agent-assisted repair is tracked as a follow-up");
    expect(caught.message).not.toContain("is not defined");
    expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  test("unsupported or degenerate migration directions fail without writing local receipts", async () => {
    for (const entry of [
      { from: "pglite", to: "postgres", url: "postgres://user:pass@127.0.0.1:1/db", message: "not implemented yet" },
      { from: "postgres", to: "pglite", url: "postgres://user:pass@127.0.0.1:1/db", message: "not implemented yet" },
      { from: "sqlite", to: "sqlite", message: "both sqlite" },
      { from: "postgres", to: "sqlite", message: "requires --url" },
    ]) {
      const cwd = makeWorkspace(`smithers-migrate-guard-${entry.from}-${entry.to}`);
      if (entry.from === "sqlite" || entry.to === "sqlite") {
        seedSqliteStore(cwd);
      }
      let caught;
      try {
        await migrateSmithersStore({ cwd, from: entry.from, to: entry.to, url: entry.url, env: {} });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SmithersError);
      expect(caught.code).toBe("INVALID_INPUT");
      expect(caught.message).toContain(entry.message);
      expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
      expect(existsSync(join(cwd, ".smithers", "migrated.json"))).toBe(false);
      expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
    }
  });

  test("resolver uses backend.json receipt after a real migrate and suppresses copied-store conflict", async () => {
    const cwd = makeWorkspace("smithers-migrate-resolver-receipt");
    seedSqliteStore(cwd);

    await migrateSmithersStore({ cwd, to: "pglite" });

    const choice = await resolveSmithersBackendChoice({ cwd, env: {} });
    expect(choice).toMatchObject({
      backend: "pglite",
      source: "marker",
      migratedMarker: true,
    });
    expect(choice.sqlite.runCount).toBe(1);
    expect(choice.pglite.runCount).toBe(1);
  });

  test("upgrades an older SQLite source before read and migration to PGlite", async () => {
    const cwd = makeWorkspace("smithers-migrate-older-sqlite");
    const dbPath = seedOlderSqliteStore(cwd);

    const readStore = await openSmithersStore({ cwd, mode: "read", backend: "sqlite", env: {} });
    await readStore.cleanup?.();

    let sqlite = new Database(dbPath, { readonly: true });
    try {
      const runColumns = sqlite.query("PRAGMA table_info(_smithers_runs)").all().map((row) => row.name);
      const eventColumns = sqlite.query("PRAGMA table_info(_smithers_events)").all().map((row) => row.name);
      expect(runColumns).toEqual(expect.arrayContaining(["workflow_path", "started_at_ms", "finished_at_ms"]));
      expect(eventColumns).toContain("timestamp_ms");
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_runs").get().count).toBe(1);
    } finally {
      sqlite.close();
    }

    const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
    expect(result.schemaVersion).toBe("0018");

    const api = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      const pgConn = api.db.connection;
      const run = await pgConn.query({
        text: "SELECT run_id, workflow_path, started_at_ms, finished_at_ms FROM _smithers_runs WHERE run_id = $1",
        values: ["run-old-1"],
      });
      expect(run.rows).toEqual([
        {
          run_id: "run-old-1",
          workflow_path: null,
          started_at_ms: null,
          finished_at_ms: null,
        },
      ]);
      const event = await pgConn.query({
        text: "SELECT run_id, seq, timestamp_ms FROM _smithers_events WHERE run_id = $1 AND seq = $2",
        values: ["run-old-1", 1],
      });
      expect(event.rows).toEqual([{ run_id: "run-old-1", seq: 1, timestamp_ms: 0 }]);
    } finally {
      await closeApi(api);
    }

    sqlite = new Database(dbPath, { readonly: true });
    try {
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_runs").get().count).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

const postgresTest = PG_URL ? test : test.skip;

describe("migrateSmithersStore real postgres", () => {
  postgresTest("copies a SQLite Smithers store to real Postgres row-for-row", async () => {
    await withTempPostgresDatabase("smithers_migrate_sqlite_pg", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-sqlite-postgres");
      const dbPath = seedSqliteStore(cwd);

      const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url, env: {} });

      expect(result.backend).toBe("postgres");
      expect(result.source.backend).toBe("sqlite");
      expect(result.target).toMatchObject({ backend: "postgres", url: "set" });
      expect(result.runCount).toBe(1);
      expect(result.schemaVersion).toBe("0018");
      expect(existsSync(result.markerPath)).toBe(true);

      const api = await openSmithersBackend({}, { cwd, backend: "postgres", connectionString: url, env: {} });
      try {
        await assertRowForRowEquality(dbPath, api.db.connection);
        expect(await tableCount(api.db.connection, "_smithers_runs")).toBe(1);
      } finally {
        await closeApi(api);
      }
    });
  });

  postgresTest("copies a real Postgres Smithers store back to SQLite with keys and indexes", async () => {
    await withTempPostgresDatabase("smithers_migrate_pg_sqlite", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-postgres-sqlite");
      seedSqliteStore(cwd);
      await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url, env: {} });
      rmSync(join(cwd, "smithers.db"), { force: true });
      rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
      rmSync(join(cwd, ".smithers", "backend.json"), { force: true });

      const result = await migrateSmithersStore({ cwd, from: "postgres", to: "sqlite", url, env: {} });

      expect(result.backend).toBe("sqlite");
      expect(result.source).toMatchObject({ backend: "postgres", url: "set" });
      expect(result.runCount).toBe(1);
      expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
      assertSqlitePrimaryKeyAndDuplicateRejection(join(cwd, "smithers.db"));
    });
  });

  postgresTest("copies a PGlite Smithers store to real Postgres row-for-row", async () => {
    await withTempPostgresDatabase("smithers_migrate_pglite_pg", async (url) => {
      const cwd = makeWorkspace("smithers-migrate-pglite-postgres");
      const sqliteSourcePath = await seedPgliteStore(cwd);

      const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url, dbPath: sqliteSourcePath, env: {} });

      expect(result.backend).toBe("postgres");
      expect(result.source.backend).toBe("sqlite");

      // Open both comparison stores directly (not via the resolver): this
      // workspace deliberately keeps an unmarked SQLite store beside the PGlite
      // one, so resolveSmithersBackendChoice correctly refuses to disambiguate.
      // The migrate path itself opens stores this way (createSmithersPostgres).
      const sourceApi = await createSmithersPostgres({}, { provider: "pglite", dataDir: join(cwd, ".smithers", "pg") });
      const targetApi = await createSmithersPostgres({}, { provider: "postgres", connectionString: url });
      try {
        const tables = await sourceApi.db.connection.query({
          text: "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
        });
        for (const row of tables.rows) {
          const table = row.table_name;
          const sourceCount = await tableCount(sourceApi.db.connection, table);
          const targetCount = await tableCount(targetApi.db.connection, table);
          expect({ table, targetCount }).toEqual({ table, targetCount: sourceCount });
        }
      } finally {
        await closeApi(targetApi);
        await closeApi(sourceApi);
      }
    });
  });
});
