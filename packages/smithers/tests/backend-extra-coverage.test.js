import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSmithersBackendChoice } from "../src/resolveSmithersBackendChoice.js";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { openSmithersStore } from "../src/openSmithersStore.js";
import { createSmithersPostgres } from "../src/create.js";
import { cleanupTempDirs, makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";

setDefaultTimeout(120_000);

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

function makeWorkspace(name) {
  const dir = makeTempDirPath(`${name}-`);
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  return dir;
}

function freePort() {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => resolveFn(address.port));
    });
  });
}

/**
 * Boot a REAL Postgres wire server backed by an embedded PGlite over a local
 * socket. Returns a live connectionString (node-postgres speaks to it exactly
 * as it would a remote Postgres) plus a seeded run table when asked. This is a
 * real backend, not a mock: the resolver/store code connects with `pg` and runs
 * genuine SQL against it.
 */
async function startPgServer({ seedRuns = false, schemaVersion = "0018_head" } = {}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const pglite = await PGlite.create();
  if (seedRuns) {
    await pglite.exec(
      `CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, created_at_ms BIGINT);`,
    );
    await pglite.exec(
      `INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms) VALUES ('r1','wf','finished',1);`,
    );
    await pglite.exec(`CREATE TABLE _smithers_schema_migrations (id TEXT PRIMARY KEY);`);
    await pglite.exec(`INSERT INTO _smithers_schema_migrations (id) VALUES ('${schemaVersion}');`);
  }
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
  await server.start();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const stop = async () => {
    await server.stop().catch(() => {});
    await pglite.close().catch(() => {});
  };
  cleanups.push(stop);
  return { connectionString, stop };
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
  cleanupTempDirs();
});

describe("resolveSmithersBackendChoice — postgres + marker edge cases", () => {
  test("inspects a real Postgres store over a connection string and closes the probe client", async () => {
    const cwd = makeWorkspace("resolver-real-pg-connstr");
    const { connectionString } = await startPgServer({ seedRuns: true, schemaVersion: "0018_head" });

    const choice = await resolveSmithersBackendChoice({ cwd, backend: "postgres", connectionString, env: {} });

    expect(choice.backend).toBe("postgres");
    expect(choice.postgres).toMatchObject({
      exists: true,
      initialized: true,
      runCount: 1,
      schemaVersion: "0018",
      connectionString: "set",
    });
  });

  test("a probe connection whose query throws is reported as an errored (empty) store", async () => {
    const cwd = makeWorkspace("resolver-pg-connection-error");
    const connection = {
      // No connectionString path: the resolver uses this injected client
      // directly. Its query throws, exercising the inspect catch branch.
      async query() {
        throw new Error("pg probe boom");
      },
    };

    const choice = await resolveSmithersBackendChoice({ cwd, backend: "postgres", connection, env: {} });
    expect(choice.postgres).toMatchObject({
      exists: true,
      initialized: false,
      runCount: 0,
      schemaVersion: "0000",
    });
    expect(choice.postgres.error).toContain("pg probe boom");
  });

  test("a malformed migrated.json is treated as an unusable marker and does not select a backend", async () => {
    const cwd = makeWorkspace("resolver-malformed-migrated");
    writeFileSync(join(cwd, ".smithers", "migrated.json"), "{ not valid json");

    const choice = await resolveSmithersBackendChoice({ cwd, env: {} });
    // A marker that cannot be parsed must not suppress anything or pick a
    // backend; resolution falls through to the sqlite default.
    expect(choice).toMatchObject({ backend: "sqlite", source: "default", migratedMarker: false });
  });

  test("a corrupt initialized PGlite store surfaces its probe error without poisoning process exit status", async () => {
    const cwd = makeWorkspace("resolver-corrupt-pglite");
    const dataDir = join(cwd, ".smithers", "pg");
    mkdirSync(dataDir, { recursive: true });
    // PG_VERSION present => the probe treats the store as initialized and tries
    // to open it; the junk contents make PGlite.create throw, hitting the catch.
    writeFileSync(join(dataDir, "PG_VERSION"), "not-a-version\n");
    writeFileSync(join(dataDir, "postgresql.conf"), "garbage");

    const exitCodeBefore = process.exitCode ?? 0;
    const choice = await resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} });
    expect(choice.pglite).toMatchObject({ exists: true, initialized: true, probed: true, runCount: 0 });
    expect(typeof choice.pglite.error).toBe("string");
    expect(process.exitCode ?? 0).toBe(exitCodeBefore);
  });

  test("an unreadable migrated PGlite target is unknown data, not a missing target", async () => {
    const cwd = makeWorkspace("resolver-unreadable-migrated-pglite");
    const sqlite = new (await import("bun:sqlite")).Database(join(cwd, "smithers.db"));
    sqlite.exec(
      `CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
       INSERT INTO _smithers_runs VALUES ('kept-source','wf','finished',1);`,
    );
    sqlite.close();

    const dataDir = join(cwd, ".smithers", "pg");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "PG_VERSION"), "not-a-version\n");
    writeFileSync(join(dataDir, "postgresql.conf"), "garbage");
    writeFileSync(
      join(cwd, ".smithers", "migrated.json"),
      JSON.stringify({ migratedAt: 1, target: { backend: "pglite" } }),
    );

    const exitCodeBefore = process.exitCode ?? 0;
    let caught;
    try {
      await resolveSmithersBackendChoice({ cwd, env: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "DB_QUERY_FAILED",
      details: {
        targetBackend: "pglite",
        targetLocation: dataDir,
        contentsKnown: false,
      },
    });
    expect(caught.message).toContain("contents are unknown");
    expect(caught.message).toContain("restore it from a known-good backup");
    expect(caught.message).not.toContain("rerun migration");
    expect(process.exitCode ?? 0).toBe(exitCodeBefore);
  });

  test("a migration receipt for pglite still refuses a stray populated non-target store", async () => {
    const cwd = makeWorkspace("resolver-migrated-stray-postgres");
    // Receipt says the workspace migrated TO pglite, but a populated Postgres
    // store (neither the target nor sqlite) also exists — choosing pglite would
    // hide those Postgres runs, so the resolver must fail the conflict guard.
    writeFileSync(
      join(cwd, ".smithers", "migrated.json"),
      JSON.stringify({ migratedAt: 1, target: { backend: "pglite" } }),
    );
    const connection = {
      async query(sql) {
        const text = typeof sql === "string" ? sql : sql.text;
        if (text.includes("to_regclass('_smithers_runs')")) return { rows: [{ table_name: "_smithers_runs" }] };
        if (text.includes("COUNT(*)::int AS count FROM _smithers_runs")) return { rows: [{ count: 5 }] };
        if (text.includes("to_regclass('_smithers_schema_migrations')"))
          return { rows: [{ table_name: "_smithers_schema_migrations" }] };
        if (text.includes("SELECT id FROM _smithers_schema_migrations")) return { rows: [{ id: "0018_head" }] };
        return { rows: [] };
      },
    };

    await expect(resolveSmithersBackendChoice({ cwd, connection, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_BACKEND_CONFLICT",
    });
  });

  test("a migration-required warning that fails to log is swallowed, not surfaced", async () => {
    const cwd = makeWorkspace("resolver-warn-logger-throws");
    const { Database } = await import("bun:sqlite");
    const sqlite = new Database(join(cwd, "smithers.db"));
    sqlite.exec(
      `CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
       INSERT INTO _smithers_runs VALUES ('r','wf','finished',1);`,
    );
    sqlite.close();
    // The structured migration warning writes through console.log; if that
    // throws, resolution must still throw the SMITHERS_MIGRATION_REQUIRED error
    // (the warning's own failure is swallowed), not a logger error.
    const origLog = console.log;
    console.log = () => {
      throw new Error("logger boom");
    };
    try {
      await expect(resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} })).rejects.toMatchObject({
        code: "SMITHERS_MIGRATION_REQUIRED",
      });
    } finally {
      console.log = origLog;
    }
  });
});

describe("openSmithersBackend — postgres branch", () => {
  test("fails loud when postgres is requested with no connection details", async () => {
    const cwd = makeWorkspace("open-backend-pg-no-conn");
    await expect(openSmithersBackend({}, { cwd, backend: "postgres", env: {} })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("opens a real Postgres backend from a connection string and provisions the schema", async () => {
    const cwd = makeWorkspace("open-backend-pg-real");
    const { connectionString } = await startPgServer();
    const api = await openSmithersBackend({}, { cwd, backend: "postgres", connectionString, env: {} });
    try {
      expect(api.db.dialect).toBe("postgres");
      const rows = await api.db.connection.query({
        text: "SELECT id FROM _smithers_schema_migrations ORDER BY id LIMIT 1",
      });
      expect(rows.rows.length).toBeGreaterThan(0);
    } finally {
      await api.close?.();
    }
  });
});

describe("openSmithersStore — read/write and postgres paths", () => {
  test("sqlite read on a missing store fails not-found (no store on disk)", async () => {
    const cwd = makeWorkspace("open-store-sqlite-missing");
    await expect(openSmithersStore({ cwd, mode: "read", env: {}, wait: { timeoutMs: 0 } })).rejects.toMatchObject({
      code: "CLI_DB_NOT_FOUND",
    });
  });

  test("sqlite read on a corrupt store reports no run history", async () => {
    const cwd = makeWorkspace("open-store-sqlite-corrupt");
    // A file exists (so the existence gate passes) but is not a valid SQLite
    // database: the run-table probe swallows the error and reports not-found.
    writeFileSync(join(cwd, "smithers.db"), "this is not a sqlite database at all");
    await expect(openSmithersStore({ cwd, mode: "read", env: {}, wait: { timeoutMs: 0 } })).rejects.toMatchObject({
      code: "CLI_DB_NOT_FOUND",
    });
  });

  test("sqlite read surfaces an exhausted write lock instead of accepting an unverified store", async () => {
    const cwd = makeWorkspace("open-store-sqlite-locked");
    // Provision a real store with the runs table and a row, then release it.
    const write = await openSmithersStore({ cwd, mode: "write", env: {} });
    const dbPath = write.dbPath;
    await write.adapter.insertRun({
      runId: "locked-run",
      workflowName: "lock-fixture",
      status: "finished",
      createdAtMs: Date.now(),
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    await write.cleanup?.();

    // Hold an EXCLUSIVE write lock on a separate connection so every other
    // connection's read races straight into a lock — exactly the transient
    // contention the campaign hit under parallel runs. Pre-fix, the run-table
    // probe swallowed that lock into a false "no run history" or assumed the
    // file was a Smithers store. Neither answer is safe while the schema is
    // unreadable, so exhausted contention must remain observable.
    const { Database } = await import("bun:sqlite");
    const locker = new Database(dbPath);
    locker.run("PRAGMA busy_timeout = 0");
    // Force rollback-journal mode so the exclusive lock blocks other readers
    // deterministically (independent of the driver's default journal mode).
    locker.run("PRAGMA journal_mode = DELETE");
    locker.run("BEGIN EXCLUSIVE");
    try {
      await expect(openSmithersStore({ cwd, mode: "read", env: {}, wait: { timeoutMs: 0 } })).rejects.toMatchObject({
        code: "SQLITE_BUSY",
      });
    } finally {
      try {
        locker.run("ROLLBACK");
      } catch {
        // best-effort unlock
      }
      locker.close();
    }
  });

  test("a non-not-found error propagates immediately without retrying", async () => {
    const cwd = makeWorkspace("open-store-invalid-backend");
    await expect(
      openSmithersStore({ cwd, backend: "mysql", env: {}, wait: { timeoutMs: 500, intervalMs: 10 } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("a not-found read is retried until the wait window elapses", async () => {
    const cwd = makeWorkspace("open-store-retry-window");
    const startedAt = Date.now();
    await expect(
      openSmithersStore({ cwd, mode: "read", env: {}, wait: { timeoutMs: 40, intervalMs: 5 } }),
    ).rejects.toMatchObject({ code: "CLI_DB_NOT_FOUND" });
    // The retry loop slept at least once before giving up.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
  });

  test("pglite read fails not-found when the store is not initialized", async () => {
    const cwd = makeWorkspace("open-store-pglite-uninit");
    mkdirSync(join(cwd, ".smithers", "pg"), { recursive: true });
    await expect(
      openSmithersStore({ cwd, backend: "pglite", mode: "read", env: {}, wait: { timeoutMs: 0 } }),
    ).rejects.toMatchObject({ code: "CLI_DB_NOT_FOUND" });
  });

  test("pglite read fails not-found when the initialized store has no run table", async () => {
    const cwd = makeWorkspace("open-store-pglite-noruns");
    const dataDir = join(cwd, ".smithers", "pg");
    const { PGlite } = await import("@electric-sql/pglite");
    const pglite = await PGlite.create(dataDir);
    await pglite.close();
    await expect(
      openSmithersStore({ cwd, backend: "pglite", mode: "read", env: {}, wait: { timeoutMs: 0 } }),
    ).rejects.toMatchObject({ code: "CLI_DB_NOT_FOUND" });
  });

  test("pglite read opens the store over a fresh socket server when the run table exists", async () => {
    const cwd = makeWorkspace("open-store-pglite-read");
    const dataDir = join(cwd, ".smithers", "pg");
    // Provision the full engine schema (creates _smithers_runs) then release it.
    const seeded = await createSmithersPostgres({}, { provider: "pglite", dataDir });
    await seeded.close();

    const store = await openSmithersStore({ cwd, backend: "pglite", mode: "read", env: {}, wait: { timeoutMs: 0 } });
    try {
      expect(store.adapter).toBeDefined();
      expect(store.db.dialect).toBe("postgres");
      const runs = await store.db.connection.query({ text: "SELECT to_regclass('_smithers_runs') AS t" });
      expect(runs.rows[0].t).toBe("_smithers_runs");
    } finally {
      await store.cleanup?.();
    }
  });

  test("postgres read connects directly to the connection string when a run table exists", async () => {
    const cwd = makeWorkspace("open-store-postgres-read");
    const { connectionString } = await startPgServer({ seedRuns: true });
    const store = await openSmithersStore({
      cwd,
      backend: "postgres",
      connectionString,
      mode: "read",
      env: {},
      wait: { timeoutMs: 0 },
    });
    try {
      expect(store.adapter).toBeDefined();
      const runs = await store.db.connection.query({ text: "SELECT COUNT(*)::int AS count FROM _smithers_runs" });
      expect(runs.rows[0].count).toBe(1);
    } finally {
      await store.cleanup?.();
    }
  });

  test("postgres read fails not-found when the run table is absent", async () => {
    const cwd = makeWorkspace("open-store-postgres-noruns");
    const { connectionString } = await startPgServer({ seedRuns: false });
    await expect(
      openSmithersStore({
        cwd,
        backend: "postgres",
        connectionString,
        mode: "read",
        env: {},
        wait: { timeoutMs: 0 },
      }),
    ).rejects.toMatchObject({ code: "CLI_DB_NOT_FOUND" });
  });

  test("write mode opens the backend and exposes a usable adapter", async () => {
    const cwd = makeWorkspace("open-store-pglite-write");
    const store = await openSmithersStore({ cwd, backend: "pglite", env: {} });
    try {
      expect(store.adapter).toBeDefined();
      expect(store.db.dialect).toBe("postgres");
    } finally {
      await store.cleanup?.();
    }
  });
});
