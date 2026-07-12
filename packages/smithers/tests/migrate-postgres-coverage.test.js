import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createSmithers } from "../src/create.js";
import { migrateSmithersStore } from "../src/migrateSmithersStore.js";

setDefaultTimeout(120_000);

/** @type {string[]} */
const tempDirs = [];
/** @type {Array<() => Promise<void>>} */
const cleanups = [];

function makeWorkspace(name) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  tempDirs.push(dir);
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

// A real Postgres wire endpoint backed by embedded PGlite. migrateSmithersStore
// connects with node-postgres and runs its full copy/verify against it.
async function startPgServer() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const pglite = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
  await server.start();
  const connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const stop = async () => {
    await server.stop().catch(() => {});
    await pglite.close().catch(() => {});
  };
  cleanups.push(stop);
  return { connectionString };
}

function seedSqliteStore(cwd, dbPath = join(cwd, "smithers.db")) {
  const api = createSmithers(
    {
      input: z.object({ prompt: z.string().nullable() }),
      result: z.object({ value: z.number().int(), ok: z.boolean() }),
    },
    { dbPath, backend: "sqlite" },
  );
  ensureSmithersTables(api.db);
  const sqlite = api.db.$client;
  sqlite.exec(`
    INSERT INTO input (run_id, prompt) VALUES ('run-migrate-1', 'hello');
    INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms, started_at_ms, finished_at_ms)
      VALUES ('run-migrate-1', 'migration-fixture', '.smithers/workflows/migration-fixture.tsx', 'finished', 10, 11, 20);
    INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
      VALUES ('run-migrate-1', 'write-result', 0, 'finished', 1, 20, 'result', 'Write result');
    INSERT INTO result (run_id, node_id, iteration, value, ok)
      VALUES ('run-migrate-1', 'write-result', 0, 42, 1);
  `);
  sqlite.close();
  return dbPath;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateSmithersStore — postgres target/source over a real wire", () => {
  test("copies a SQLite store to Postgres row-for-row and writes a receipt", async () => {
    const cwd = makeWorkspace("migrate-sqlite-to-pg");
    seedSqliteStore(cwd);
    const { connectionString } = await startPgServer();

    const result = await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url: connectionString, env: {} });

    expect(result.backend).toBe("postgres");
    expect(result.source.backend).toBe("sqlite");
    expect(result.target).toMatchObject({ backend: "postgres", url: "set" });
    expect(result.runCount).toBe(1);
    expect(existsSync(result.markerPath)).toBe(true);
  });

  test("copies a Postgres store back to SQLite with keys and indexes", async () => {
    const cwd = makeWorkspace("migrate-pg-to-sqlite");
    seedSqliteStore(cwd);
    const { connectionString } = await startPgServer();

    // Forward first so the Postgres store holds the run history.
    await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url: connectionString, env: {} });
    // Drop the local sqlite + receipts so the reverse migration is unambiguous.
    rmSync(join(cwd, "smithers.db"), { force: true });
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });

    const result = await migrateSmithersStore({ cwd, from: "postgres", to: "sqlite", url: connectionString, env: {} });

    expect(result.backend).toBe("sqlite");
    expect(result.source).toMatchObject({ backend: "postgres", url: "set" });
    expect(result.runCount).toBe(1);
    expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
  });

  test("infers a Postgres source from run history when --from is omitted", async () => {
    const cwd = makeWorkspace("migrate-infer-pg");
    seedSqliteStore(cwd);
    const { connectionString } = await startPgServer();
    await migrateSmithersStore({ cwd, from: "sqlite", to: "postgres", url: connectionString, env: {} });
    rmSync(join(cwd, "smithers.db"), { force: true });
    rmSync(join(cwd, ".smithers", "migrated.json"), { force: true });
    rmSync(join(cwd, ".smithers", "backend.json"), { force: true });

    // No `from`: inference must count the Postgres runs (via the injected url)
    // and select postgres as the only populated backend.
    const result = await migrateSmithersStore({ cwd, to: "sqlite", url: connectionString, env: {} });
    expect(result.source.backend).toBe("postgres");
    expect(result.runCount).toBe(1);
  });
});
