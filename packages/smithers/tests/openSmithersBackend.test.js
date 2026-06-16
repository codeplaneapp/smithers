import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSmithersBackend } from "../src/openSmithersBackend.js";

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
  test("defaults fresh workspaces to persisted PGlite", async () => {
    const cwd = makeWorkspace("smithers-open-pglite");
    const api = await openSmithersBackend({}, { cwd, env: {} });
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

  test("fails loud when a legacy sqlite store has runs and backend resolves to pglite", async () => {
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

    await expect(openSmithersBackend({}, { cwd, env: {} })).rejects.toMatchObject({
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

  test("a present .smithers/migrated.json marker suppresses the migration-required guard", async () => {
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
    writeFileSync(join(cwd, ".smithers", "migrated.json"), JSON.stringify({ migratedAt: 1 }));

    const api = await openSmithersBackend({}, { cwd, env: {} });
    try {
      expect(api.db.dialect).toBe("postgres");
    } finally {
      await closeApi(api);
    }
  });
});
