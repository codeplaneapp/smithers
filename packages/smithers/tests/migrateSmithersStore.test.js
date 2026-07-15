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

import { chunkedTest, assertRowForRowEquality, canonicalRows, listSourceTables, normalizeCell, sourceColumns, assertSqlitePrimaryKeyAndDuplicateRejection, closeApi, makeWorkspace, PG_URL, pgUrlForDatabase, quoteId, seedOlderSqliteStore, seedPgliteStore, seedPgliteStoreWithReceipt, seedSqliteStore, sqliteRunIds, tableCount, tempPgDatabaseName, withTempPostgresDatabase } from "./migrateStoreKit.js";

setDefaultTimeout(120_000);

describe("migrateSmithersStore", () => {
  chunkedTest("copies a SQLite Smithers store to PGlite row-for-row and writes migrated.json", async () => {
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
    expect(result.schemaVersion).toBe("0028");
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
      expect(await tableCount(pgConn, "_smithers_snapshot_contents")).toBe(1);
      expect(await tableCount(pgConn, "_smithers_snapshot_payload_refs")).toBe(1);
      const snapshotContent = await pgConn.query({ text: "SELECT ref_count FROM _smithers_snapshot_contents" });
      expect(Number(snapshotContent.rows[0].ref_count)).toBe(1);
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

  chunkedTest("infers nested .smithers/smithers.db as the SQLite source when it has runs", async () => {
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

  chunkedTest("migrates every row of every table row-for-row and yields a replayable (fork/time-travel) run on the target", async () => {
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
      const childSnapshot = await loadSnapshot(adapter, fork.runId, 0);
      expect(JSON.parse(childSnapshot.inputJson)).toEqual({ prompt: "hello" });
    } finally {
      await closeApi(api);
    }
  });

  chunkedTest("rejects with an actionable SmithersError when the source store is corrupt, leaving no partial output", async () => {
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

  chunkedTest("rejects with an actionable SmithersError when the source store cannot be opened, leaving no partial output", async () => {
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

  chunkedTest("migrate --to postgres with no url fails with INVALID_INPUT before opening the source (not masked)", async () => {
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

  chunkedTest("can remove sqlite files only after a successful copy", async () => {
    const cwd = makeWorkspace("smithers-migrate-remove-sqlite");
    const dbPath = seedSqliteStore(cwd);
    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL; INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES ('run-migrate-1', 2, 23, 'SidecarSeed', '{}');");
    sqlite.close();
    // Some SQLite builds checkpoint and remove WAL/SHM sidecars when the last
    // connection closes. The migration cleanup promise is filesystem-level:
    // if sidecars exist after a successful copy, they must be removed. The
    // fixture sidecars must be validly SHAPED (a WAL header with the real
    // magic, one zeroed shm region): garbage content is refused up front with
    // an actionable error (its own test below), because letting SQLite mmap a
    // malformed wal/shm kills the whole process under bun with a Bus error.
    const walHeader = Buffer.alloc(32);
    walHeader.writeUInt32BE(0x377f0682, 0); // WAL magic (little-endian checksums)
    walHeader.writeUInt32BE(3007000, 4); // format version
    walHeader.writeUInt32BE(4096, 8); // page size
    writeFileSync(`${dbPath}-wal`, walHeader);
    writeFileSync(`${dbPath}-shm`, Buffer.alloc(32768));
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);

    const result = await migrateSmithersStore({ cwd, to: "pglite", keepSqlite: false });

    expect(result.sqliteRemoved).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(result.markerPath)).toBe(true);
  });

  chunkedTest("malformed WAL/SHM sidecars are refused with an actionable error, never a crash", async () => {
    const cwd = makeWorkspace("smithers-migrate-bad-sidecars");
    const dbPath = seedSqliteStore(cwd);
    // A truncated/garbage sidecar used to SIGBUS the whole bun process when
    // SQLite mmapped it during the migration's source open.
    writeFileSync(`${dbPath}-wal`, "sidecar", "utf8");

    let caught;
    try {
      await migrateSmithersStore({ cwd, to: "pglite" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SmithersError);
    expect(String(caught?.message)).toContain("malformed");
    // Source files are untouched so the user can repair or remove them.
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    rmSync(`${dbPath}-wal`, { force: true });
    writeFileSync(`${dbPath}-shm`, "sidecar", "utf8");
    caught = undefined;
    try {
      await migrateSmithersStore({ cwd, to: "pglite" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SmithersError);
    expect(String(caught?.message)).toContain("malformed");
  });
});
