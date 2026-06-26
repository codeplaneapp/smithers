import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { openSmithersStore } from "../src/openSmithersStore.js";

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
  delete process.env.SMITHERS_BACKEND;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openSmithersBackend", () => {
  test("defaults fresh workspaces to SQLite", async () => {
    const cwd = makeWorkspace("smithers-open-sqlite-default");
    const api = await openSmithersBackend({}, { cwd, env: {} });
    try {
      expect(api.db.$client).toBeDefined();
      expect(existsSync(join(cwd, "smithers.db"))).toBe(true);
      expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
    } finally {
      await closeApi(api);
    }
  });

  test("honors explicit pglite in fresh workspaces", async () => {
    const cwd = makeWorkspace("smithers-open-pglite-explicit");
    const api = await openSmithersBackend({}, { cwd, backend: "pglite", env: {} });
    try {
      expect(api.db.dialect).toBe("postgres");
      expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(true);
      const rows = await api.db.connection.query({ text: "SELECT id FROM _smithers_schema_migrations ORDER BY id" });
      expect(rows.rows.map((row) => row.id)).toContain("0001_current_tables");
      expect(rows.rows.map((row) => row.id)).toContain("0016_add_workspace_checkpoints");
    } finally {
      await closeApi(api);
    }
  });

  test("read mode does not provision Smithers schema in an initialized empty PGlite store", async () => {
    const cwd = makeWorkspace("smithers-open-pglite-read-no-provision");
    const dataDir = join(cwd, ".smithers", "pg");
    const { PGlite } = await import("@electric-sql/pglite");
    const pglite = await PGlite.create(dataDir);
    await pglite.close();

    await expect(openSmithersStore({ cwd, backend: "pglite", mode: "read", env: {}, wait: { timeoutMs: 0 } })).rejects.toMatchObject({
      code: "CLI_DB_NOT_FOUND",
    });

    const check = await PGlite.create(dataDir);
    try {
      const tables = await check.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE '_smithers_%'");
      expect(tables.rows).toEqual([]);
    } finally {
      await check.close();
    }
  });

  test("forwards custom pgliteDataDir through resolve and opens that store", async () => {
    const cwd = makeWorkspace("smithers-open-custom-pglite-dir");
    const customDir = join(cwd, ".smithers", "custom-pg");
    const seeded = await openSmithersBackend({}, { cwd, backend: "pglite", pgliteDataDir: customDir, env: {} });
    try {
      await seeded.db.connection.query({
        text: `
          INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms)
          VALUES ('custom-dir-run', 'wf', 'wf.tsx', 'finished', 1)
        `,
      });
    } finally {
      await closeApi(seeded);
    }

    const api = await openSmithersBackend({}, { cwd, backend: "pglite", pgliteDataDir: customDir, env: {} });
    try {
      const rows = await api.db.connection.query({ text: "SELECT run_id FROM _smithers_runs ORDER BY run_id" });
      expect(rows.rows.map((row) => row.run_id)).toContain("custom-dir-run");
      expect(existsSync(customDir)).toBe(true);
      expect(existsSync(join(cwd, ".smithers", "pg"))).toBe(false);
    } finally {
      await closeApi(api);
    }
  });

  test("honors explicit sqlite and SMITHERS_BACKEND overrides", async () => {
    const explicitCwd = makeWorkspace("smithers-open-sqlite-explicit");
    const explicit = await openSmithersBackend({}, { cwd: explicitCwd, backend: "sqlite", env: {} });
    try {
      expect(explicit.db.$client).toBeDefined();
    } finally {
      await closeApi(explicit);
    }

    const envCwd = makeWorkspace("smithers-open-sqlite-env");
    const fromEnv = await openSmithersBackend({}, { cwd: envCwd, env: { SMITHERS_BACKEND: "sqlite" } });
    try {
      expect(fromEnv.db.$client).toBeDefined();
    } finally {
      await closeApi(fromEnv);
    }
  });

  test("honors backend from .smithers/smithers.config.ts", async () => {
    const cwd = makeWorkspace("smithers-open-config");
    writeFileSync(join(cwd, ".smithers", "smithers.config.ts"), "export default { backend: 'sqlite' };\n");
    const api = await openSmithersBackend({}, { cwd, env: {} });
    try {
      expect(api.db.$client).toBeDefined();
    } finally {
      await closeApi(api);
    }
  });

  test("fails loud when a legacy sqlite store has runs and backend explicitly resolves to pglite", async () => {
    const cwd = makeWorkspace("smithers-open-migration-required");
    const dbPath = join(cwd, "smithers.db");
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE _smithers_schema_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL,
        checksum TEXT,
        destructive INTEGER NOT NULL DEFAULT 0,
        details_json TEXT
      );
      INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
        VALUES ('legacy-run', 'wf', 'finished', 1);
      INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms)
        VALUES ('0016_add_workspace_checkpoints', 'head', 1);
    `);
    sqlite.close();

    await expect(openSmithersBackend({}, { cwd, env: { SMITHERS_BACKEND: "pglite" } })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: {
        runCount: 1,
        schemaVersion: "0016",
        resolvedBackend: "pglite",
      },
    });
  });

  test("explicit sqlite suppresses the migration-required guard", async () => {
    const cwd = makeWorkspace("smithers-open-sqlite-legacy");
    const dbPath = join(cwd, "smithers.db");
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
        VALUES ('legacy-run', 'wf', 'finished', 1);
    `);
    sqlite.close();

    const api = await openSmithersBackend({}, { cwd, backend: "sqlite", env: {} });
    try {
      expect(api.db.$client).toBeDefined();
    } finally {
      await closeApi(api);
    }
  });

  test("a bare .smithers/migrated.json marker (no target backend) does NOT suppress the migration-required guard", async () => {
    const cwd = makeWorkspace("smithers-open-stale-marker");
    const dbPath = join(cwd, "smithers.db");
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE _smithers_runs (
        run_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
        VALUES ('legacy-run', 'wf', 'finished', 1);
    `);
    sqlite.close();
    // A receipt with no parseable target backend must not silently hide the
    // SQLite run history behind an empty PGlite store.
    writeFileSync(join(cwd, ".smithers", "migrated.json"), JSON.stringify({ migratedAt: 1 }));

    await expect(openSmithersBackend({}, { cwd, env: { SMITHERS_BACKEND: "pglite" } })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
    });
  });
});
