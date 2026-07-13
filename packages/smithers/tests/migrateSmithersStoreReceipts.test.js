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

import { chunkedTest, assertRowForRowEquality, assertSqlitePrimaryKeyAndDuplicateRejection, closeApi, makeWorkspace, PG_URL, pgUrlForDatabase, quoteId, seedOlderSqliteStore, seedPgliteStore, seedPgliteStoreWithReceipt, seedSqliteStore, sqliteRunIds, tableCount, tempPgDatabaseName, withTempPostgresDatabase } from "./migrateStoreKit.js";

setDefaultTimeout(120_000);

describe("migrateSmithersStore targets and receipts", () => {
  chunkedTest("a non-empty uninitialized PGlite target is preserved without invoking initdb", async () => {
    const cwd = makeWorkspace("smithers-migrate-nonempty-uninitialized-pglite-target");
    const dbPath = seedSqliteStore(cwd);
    const sqliteBefore = readFileSync(dbPath);
    const dataDir = join(cwd, ".smithers", "pg");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "preserve-me"), "unknown target contents\n", "utf8");
    const markerPath = join(cwd, ".smithers", "migrated.json");
    const existingReceipt = "existing receipt must survive\n";
    writeFileSync(markerPath, existingReceipt, "utf8");

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_WRITE_FAILED");
    expect(caught.message).toContain(dataDir);
    expect(caught.message).toContain("non-empty but has no PG_VERSION");
    expect(caught.message).toContain("contents are unknown");
    expect(caught.message).toContain("Back up and move");
    expect(caught.message).toContain("repair the PGlite store in place");
    expect(caught.message).not.toContain("contains data or is not writable");
    expect(caught.details).toMatchObject({
      failure: "pglite-target-nonempty-uninitialized",
      targetBackend: "pglite",
      dataDir,
      targetContents: "unknown",
      entryCount: 1,
    });

    expect(readFileSync(join(dataDir, "preserve-me"), "utf8")).toBe("unknown target contents\n");
    expect(existsSync(join(dataDir, "PG_VERSION"))).toBe(false);
    expect(readFileSync(markerPath, "utf8")).toBe(existingReceipt);
    expect(readFileSync(dbPath)).toEqual(sqliteBefore);
    expect(sqliteRunIds(dbPath)).toEqual(["run-migrate-1"]);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  chunkedTest("an unreadable initialized PGlite target reports unknown contents and preserves all stores and receipts", async () => {
    const cwd = makeWorkspace("smithers-migrate-unreadable-pglite-target");
    const dbPath = seedSqliteStore(cwd);
    const dataDir = join(cwd, ".smithers", "pg");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "PG_VERSION"), "18\n", "utf8");
    writeFileSync(join(dataDir, "postgresql.conf"), "not valid PostgreSQL configuration\n", "utf8");
    writeFileSync(join(dataDir, "preserve-me"), "target sentinel\n", "utf8");
    const sqliteBefore = readFileSync(dbPath);
    const markerPath = join(cwd, ".smithers", "migrated.json");
    const existingReceipt = `${JSON.stringify({
      migratedAt: "2026-01-01T00:00:00.000Z",
      source: { backend: "sqlite", dbPath, runCount: 1 },
      target: { backend: "pglite", dataDir },
    }, null, 2)}\n`;
    writeFileSync(markerPath, existingReceipt, "utf8");

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_WRITE_FAILED");
    expect(caught.message).toContain(dataDir);
    expect(caught.message).toContain("contents are unknown");
    expect(caught.message).toContain("Back up and move");
    expect(caught.message).toContain("repair the PGlite store in place");
    expect(caught.message).toContain("Do not blindly remove");
    expect(caught.message).toContain("retry migration against the same directory");
    expect(caught.message).not.toContain("contains data or is not writable");
    expect(caught.details).toMatchObject({
      failure: "pglite-target-open",
      targetBackend: "pglite",
      dataDir,
      targetContents: "unknown",
    });
    expect(typeof caught.details.originalError).toBe("string");
    expect(caught.cause).toBeInstanceOf(Error);

    expect(readFileSync(join(dataDir, "PG_VERSION"), "utf8")).toBe("18\n");
    expect(readFileSync(join(dataDir, "postgresql.conf"), "utf8")).toBe("not valid PostgreSQL configuration\n");
    expect(readFileSync(join(dataDir, "preserve-me"), "utf8")).toBe("target sentinel\n");
    expect(readFileSync(markerPath, "utf8")).toBe(existingReceipt);
    expect(readFileSync(dbPath)).toEqual(sqliteBefore);
    expect(sqliteRunIds(dbPath)).toEqual(["run-migrate-1"]);
    expect(existsSync(join(cwd, ".smithers", "backend.json"))).toBe(false);
  });

  chunkedTest("unsupported or degenerate migration directions fail without writing local receipts", async () => {
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

  chunkedTest("resolver uses backend.json receipt after a real migrate and suppresses copied-store conflict", async () => {
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

  chunkedTest("read leaves an older SQLite source untouched; migrate upgrades it before copying to PGlite", async () => {
    const cwd = makeWorkspace("smithers-migrate-older-sqlite");
    const dbPath = seedOlderSqliteStore(cwd);

    const readStore = await openSmithersStore({ cwd, mode: "read", backend: "sqlite", env: {} });
    await readStore.cleanup?.();

    let sqlite = new Database(dbPath, { readonly: true });
    try {
      // Read mode executes no DDL (singleton-gateway.md decision 9): the old
      // schema stays old until a writer or `smithers migrate` brings it
      // forward. `smithers ps` is not a writer.
      const runColumns = sqlite.query("PRAGMA table_info(_smithers_runs)").all().map((row) => row.name);
      expect(runColumns).not.toContain("workflow_path");
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_runs").get().count).toBe(1);
    } finally {
      sqlite.close();
    }

    const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite" });
    expect(result.schemaVersion).toBe("0026");

    // The migration itself upgraded the source schema before copying.
    sqlite = new Database(dbPath, { readonly: true });
    try {
      const runColumns = sqlite.query("PRAGMA table_info(_smithers_runs)").all().map((row) => row.name);
      const eventColumns = sqlite.query("PRAGMA table_info(_smithers_events)").all().map((row) => row.name);
      expect(runColumns).toEqual(expect.arrayContaining(["workflow_path", "started_at_ms", "finished_at_ms"]));
      expect(eventColumns).toContain("timestamp_ms");
    } finally {
      sqlite.close();
    }

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

  // Issue 1: round-trip sqlite→pglite (keepSqlite:true) then pglite→sqlite must
  // succeed. The receipt records the original sqlite source; the reverse migration
  // reads it to allow overwriting that specific populated file.
  chunkedTest("round-trip pglite→sqlite succeeds when keepSqlite:true left the source sqlite on disk", async () => {
    const cwd = makeWorkspace("smithers-migrate-roundtrip-keepsqlite");
    seedSqliteStore(cwd);

    // Forward migration with keepSqlite:true — leaves smithers.db on disk.
    const forward = await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: true });
    expect(forward.backend).toBe("pglite");
    expect(forward.sqliteRemoved).toBe(false);
    expect(existsSync(join(cwd, "smithers.db"))).toBe(true);

    // Reverse migration must NOT throw DB_WRITE_FAILED even though smithers.db
    // has runs — it was the forward-migration source, so overwriting it restores
    // the data to its origin, not a merge of two independent histories.
    const reverse = await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });
    expect(reverse.backend).toBe("sqlite");
    expect(reverse.source.backend).toBe("pglite");
    expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1"]);
  });

  chunkedTest("reverse migration refuses to overwrite a kept SQLite source modified after migration", async () => {
    const cwd = makeWorkspace("smithers-migrate-roundtrip-modified-source");
    seedSqliteStore(cwd);

    const forward = await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", keepSqlite: true });
    expect(forward.backend).toBe("pglite");

    const sqlite = new Database(join(cwd, "smithers.db"));
    try {
      sqlite.exec(`
        INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms, started_at_ms, finished_at_ms)
          VALUES ('run-sqlite-only', 'sqlite-only', '.smithers/workflows/sqlite-only.tsx', 'finished', 30, 31, 32);
      `);
    } finally {
      sqlite.close();
    }

    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "pglite", to: "sqlite" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_WRITE_FAILED");
    expect(caught.message).toContain("changed after that migration");
    expect(sqliteRunIds(join(cwd, "smithers.db"))).toEqual(["run-migrate-1", "run-sqlite-only"]);
  });

  // Issue 5: DB_WRITE_FAILED must not suggest retrying the exact same command
  // because retrying will always hit the same target-has-data guard.
  chunkedTest("DB_WRITE_FAILED error message does not suggest retrying the same command", async () => {
    const cwd = makeWorkspace("smithers-migrate-write-conflict-message");
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
    expect(caught.code).toBe("DB_WRITE_FAILED");
    // Must NOT suggest retrying the exact same failing command — it will always
    // hit the same populated-target guard.
    expect(caught.message).not.toContain("smithers migrate --from pglite --to sqlite");
    // Must still include the "Agent-assisted repair" marker (withAgentFallback
    // is still called, just with different text for write-conflict errors).
    expect(caught.message).toContain("Agent-assisted repair is tracked as a follow-up");
    // Should tell the operator to inspect or remove the conflicting target.
    expect(caught.message.toLowerCase()).toContain("target store");
  });

  chunkedTest("a real PGlite target with missing WAL reports the recovery failure without rewriting successful receipts", async () => {
    const cwd = makeWorkspace("smithers-migrate-real-pglite-missing-wal");
    const dbPath = await seedPgliteStoreWithReceipt(cwd, { keepSqlite: true });
    const dataDir = join(cwd, ".smithers", "pg");
    const markerPath = join(cwd, ".smithers", "migrated.json");
    const backendMarkerPath = join(cwd, ".smithers", "backend.json");
    const markerBefore = readFileSync(markerPath, "utf8");
    const backendMarkerBefore = readFileSync(backendMarkerPath, "utf8");
    const sqliteBefore = readFileSync(dbPath);
    const pgControlPath = join(dataDir, "global", "pg_control");
    const pgControlBefore = readFileSync(pgControlPath);
    const pgVersionBefore = readFileSync(join(dataDir, "PG_VERSION"), "utf8");
    writeFileSync(join(dataDir, "preserve-me"), "real target sentinel\n", "utf8");

    const walDir = join(dataDir, "pg_wal");
    const walSegments = readdirSync(walDir).filter((name) => /^[0-9A-F]{24}$/.test(name));
    expect(walSegments.length).toBeGreaterThan(0);
    for (const segment of walSegments) {
      rmSync(join(walDir, segment));
    }

    const previousExitCode = process.exitCode;
    let caught;
    try {
      await migrateSmithersStore({ cwd, from: "sqlite", to: "pglite", env: {} });
    } catch (error) {
      caught = error;
    } finally {
      // Emscripten marks the host process failed when Postgres PANICs even though
      // PGlite exposes the RuntimeError to our caller and the test handles it.
      process.exitCode = previousExitCode;
    }

    expect(caught).toBeInstanceOf(SmithersError);
    expect(caught.code).toBe("DB_WRITE_FAILED");
    expect(caught.message).toContain(dataDir);
    expect(caught.message).toContain("contents are unknown");
    expect(caught.message).toContain("Back up and move");
    expect(caught.message).toContain("repair the PGlite store in place");
    expect(caught.message).toContain("Original PGlite error");
    expect(caught.message).not.toBe("Aborted(). Build with -sASSERTIONS for more info.");
    expect(caught.message).not.toContain("contains data or is not writable");
    expect(caught.details).toMatchObject({
      failure: "pglite-target-open",
      targetBackend: "pglite",
      dataDir,
      targetContents: "unknown",
      originalError: "Aborted(). Build with -sASSERTIONS for more info.",
    });
    expect(caught.cause).toBeInstanceOf(Error);
    expect(caught.cause.message).toBe("Aborted(). Build with -sASSERTIONS for more info.");

    expect(readFileSync(join(dataDir, "preserve-me"), "utf8")).toBe("real target sentinel\n");
    expect(readFileSync(join(dataDir, "PG_VERSION"), "utf8")).toBe(pgVersionBefore);
    expect(readFileSync(pgControlPath)).toEqual(pgControlBefore);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
    expect(readFileSync(backendMarkerPath, "utf8")).toBe(backendMarkerBefore);
    expect(readFileSync(dbPath)).toEqual(sqliteBefore);
    expect(sqliteRunIds(dbPath)).toEqual(["run-migrate-1"]);
  });
});
