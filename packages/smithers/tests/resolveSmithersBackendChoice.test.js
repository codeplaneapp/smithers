import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSmithersBackend } from "../src/openSmithersBackend.js";
import { createSmithersPostgres } from "../src/create.js";
import { resolveSmithersBackendChoice } from "../src/resolveSmithersBackendChoice.js";

setDefaultTimeout(120_000);

/** @type {string[]} */
const tempDirs = [];

function makeWorkspace(name) {
  const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, ".smithers"), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function seedSqliteRuns(cwd, dbPath = join(cwd, "smithers.db")) {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _smithers_runs (
      run_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _smithers_schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      checksum TEXT,
      destructive INTEGER NOT NULL DEFAULT 0,
      details_json TEXT
    );
    INSERT OR REPLACE INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
      VALUES ('sqlite-run', 'wf', 'finished', 1);
    INSERT OR REPLACE INTO _smithers_schema_migrations (id, name, applied_at_ms)
      VALUES ('0016_add_workspace_checkpoints', 'head', 1);
  `);
  sqlite.close();
}

function seedEmptySqlite(cwd, dbPath = join(cwd, "smithers.db")) {
  const sqlite = new Database(dbPath);
  sqlite.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
  sqlite.close();
}

async function seedPgliteRuns(cwd) {
  // Open the PGlite store directly (not via the resolver), so seeding a PGlite
  // store beside a populated SQLite store doesn't trip the conflict/migration
  // guards — and leaves NO markers behind for the resolver tests to inspect.
  const dataDir = join(cwd, ".smithers", "pg");
  const api = await createSmithersPostgres({}, { provider: "pglite", dataDir });
  try {
    await api.db.connection.query({
      text: `
        INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms)
        VALUES ('pglite-run', 'wf', 'wf.tsx', 'finished', 1)
      `,
    });
  } finally {
    await api.close?.();
  }
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

describe("resolveSmithersBackendChoice", () => {
  test("default sqlite ignores absent, empty, and uninitialized stores", async () => {
    for (const state of ["absent", "empty-sqlite", "uninitialized-pglite"]) {
      const cwd = makeWorkspace(`resolver-default-${state}`);
      if (state === "empty-sqlite") {
        seedEmptySqlite(cwd);
      }
      if (state === "uninitialized-pglite") {
        mkdirSync(join(cwd, ".smithers", "pg"), { recursive: true });
      }

      const choice = await resolveSmithersBackendChoice({ cwd, env: {} });
      expect(choice.backend).toBe("sqlite");
      expect(choice.source).toBe("default");
      expect(choice.sqlite.runCount).toBe(0);
      expect(choice.pglite.runCount).toBe(0);
      if (state === "uninitialized-pglite") {
        expect(choice.pglite.exists).toBe(true);
        expect(choice.pglite.initialized).toBe(false);
      }
    }
  });

  test("default sqlite does not inspect ambient DATABASE_URL", async () => {
    const cwd = makeWorkspace("resolver-default-ignores-database-url");

    const choice = await resolveSmithersBackendChoice({
      cwd,
      env: { DATABASE_URL: "postgres://user:pass@203.0.113.1:1/smithers" },
    });

    expect(choice.backend).toBe("sqlite");
    expect(choice.postgres).toEqual({
      exists: false,
      initialized: false,
      runCount: 0,
      schemaVersion: "0000",
    });
  });

  test("all explicit/env/config/marker sources can select every backend when stores are clean", async () => {
    const sources = [
      { source: "options", options: (backend) => ({ backend }) },
      { source: "env", options: (backend) => ({ env: { SMITHERS_BACKEND: backend } }) },
      {
        source: "config",
        options: (backend, cwd) => {
          writeFileSync(join(cwd, ".smithers", "smithers.config.ts"), `export default { backend: "${backend}" };\n`);
          return { env: {} };
        },
      },
      {
        source: "marker",
        options: (backend, cwd) => {
          writeFileSync(join(cwd, ".smithers", "backend.json"), JSON.stringify({ backend }));
          return { env: {} };
        },
      },
    ];

    for (const backend of ["sqlite", "pglite", "postgres"]) {
      for (const entry of sources) {
        const cwd = makeWorkspace(`resolver-${entry.source}-${backend}`);
        const choice = await resolveSmithersBackendChoice({ cwd, ...entry.options(backend, cwd) });
        expect({ backend: choice.backend, source: choice.source }).toEqual({ backend, source: entry.source });
      }
    }
  });

  test("populated sqlite blocks explicit pglite/postgres without a migration receipt", async () => {
    for (const backend of ["pglite", "postgres"]) {
      const cwd = makeWorkspace(`resolver-sqlite-blocks-${backend}`);
      seedSqliteRuns(cwd);
      await expect(resolveSmithersBackendChoice({ cwd, backend, env: {} })).rejects.toMatchObject({
        code: "SMITHERS_MIGRATION_REQUIRED",
        details: { sourceBackend: "sqlite", targetBackend: backend, runCount: 1 },
      });
    }
  });

  test("unreadable sqlite store is not silently treated as empty for pglite selection", async () => {
    const cwd = makeWorkspace("resolver-unreadable-sqlite");
    const dbPath = join(cwd, "smithers.db");
    seedSqliteRuns(cwd, dbPath);
    chmodSync(dbPath, 0o000);
    try {
      await expect(resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} })).rejects.toMatchObject({
        code: "DB_QUERY_FAILED",
        details: { dbPath, sourceBackend: "sqlite", targetBackend: "pglite" },
      });
    } finally {
      chmodSync(dbPath, 0o600);
    }
  });

  test("populated pglite blocks the new sqlite default unless pglite is authorized", async () => {
    const cwd = makeWorkspace("resolver-pglite-blocks-default");
    await seedPgliteRuns(cwd);

    await expect(resolveSmithersBackendChoice({ cwd, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: { sourceBackend: "pglite", targetBackend: "sqlite", runCount: 1 },
    });

    const explicit = await resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} });
    expect(explicit.backend).toBe("pglite");
    expect(explicit.pglite.runCount).toBe(1);

    writeFileSync(join(cwd, ".smithers", "backend.json"), JSON.stringify({ backend: "pglite" }));
    const marker = await resolveSmithersBackendChoice({ cwd, env: {} });
    expect(marker.backend).toBe("pglite");
    expect(marker.source).toBe("marker");
  });

  test("populated sqlite and pglite stores fail as a conflict without a migration receipt", async () => {
    const cwd = makeWorkspace("resolver-conflict");
    seedSqliteRuns(cwd);
    await seedPgliteRuns(cwd);

    await expect(resolveSmithersBackendChoice({ cwd, env: { SMITHERS_BACKEND: "pglite" } })).rejects.toMatchObject({
      code: "SMITHERS_BACKEND_CONFLICT",
      details: {
        populatedBackends: ["sqlite", "pglite"],
      },
    });
  });

  test("migrated.json target selects migrated backend when backend.json is absent and sqlite was kept", async () => {
    const cwd = makeWorkspace("resolver-migrated-marker");
    seedSqliteRuns(cwd);
    await seedPgliteRuns(cwd);
    writeFileSync(join(cwd, ".smithers", "migrated.json"), JSON.stringify({ migratedAt: 1, target: { backend: "pglite" } }));

    const choice = await resolveSmithersBackendChoice({ cwd, env: {} });
    expect(choice).toMatchObject({
      backend: "pglite",
      source: "marker",
      migratedMarker: true,
      sqlite: { runCount: 1 },
      pglite: { runCount: 1 },
    });

    const api = await openSmithersBackend({}, { cwd, env: {} });
    try {
      expect(api.db.dialect).toBe("postgres");
    } finally {
      await closeApi(api);
    }
  });

  test("migrated.json target fails loud when migrated target is missing but kept sqlite has runs", async () => {
    const cwd = makeWorkspace("resolver-migrated-marker-missing-target");
    seedSqliteRuns(cwd);
    writeFileSync(join(cwd, ".smithers", "migrated.json"), JSON.stringify({ migratedAt: 1, target: { backend: "pglite" } }));

    await expect(resolveSmithersBackendChoice({ cwd, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: {
        sourceBackend: "sqlite",
        targetBackend: "pglite",
        dbPath: join(cwd, "smithers.db"),
        runCount: 1,
      },
    });
  });

  test("backend.json selects backend but does not suppress migration or conflict guards", async () => {
    const sqliteOnly = makeWorkspace("resolver-marker-sqlite-blocks");
    writeFileSync(join(sqliteOnly, ".smithers", "backend.json"), JSON.stringify({ backend: "pglite" }));
    seedSqliteRuns(sqliteOnly);
    await expect(resolveSmithersBackendChoice({ cwd: sqliteOnly, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: { sourceBackend: "sqlite", targetBackend: "pglite" },
    });

    const conflict = makeWorkspace("resolver-marker-conflict");
    writeFileSync(join(conflict, ".smithers", "backend.json"), JSON.stringify({ backend: "pglite" }));
    seedSqliteRuns(conflict);
    await seedPgliteRuns(conflict);
    await expect(resolveSmithersBackendChoice({ cwd: conflict, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_BACKEND_CONFLICT",
    });

    writeFileSync(join(sqliteOnly, ".smithers", "migrated.json"), JSON.stringify({ migratedAt: 1 }));
    await expect(resolveSmithersBackendChoice({ cwd: sqliteOnly, env: {} })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: { sourceBackend: "sqlite", targetBackend: "pglite" },
    });
  });

  test("source precedence is explicit over env over config over backend marker over default", async () => {
    const envConfig = makeWorkspace("resolver-precedence-env-config");
    writeFileSync(join(envConfig, ".smithers", "smithers.config.ts"), 'export default { backend: "postgres" };\n');
    expect(await resolveSmithersBackendChoice({ cwd: envConfig, env: { SMITHERS_BACKEND: "pglite" } })).toMatchObject({
      backend: "pglite",
      source: "env",
    });

    const explicitEnv = makeWorkspace("resolver-precedence-explicit-env");
    expect(await resolveSmithersBackendChoice({ cwd: explicitEnv, backend: "postgres", env: { SMITHERS_BACKEND: "pglite" } })).toMatchObject({
      backend: "postgres",
      source: "options",
    });

    const configMarker = makeWorkspace("resolver-precedence-config-marker");
    writeFileSync(join(configMarker, ".smithers", "smithers.config.ts"), 'export const backend = "pglite";\n');
    writeFileSync(join(configMarker, ".smithers", "backend.json"), JSON.stringify({ backend: "postgres" }));
    expect(await resolveSmithersBackendChoice({ cwd: configMarker, env: {} })).toMatchObject({
      backend: "pglite",
      source: "config",
    });

    const markerOnly = makeWorkspace("resolver-precedence-marker");
    writeFileSync(join(markerOnly, ".smithers", "backend.json"), JSON.stringify({ backend: "postgres" }));
    expect(await resolveSmithersBackendChoice({ cwd: markerOnly, env: {} })).toMatchObject({
      backend: "postgres",
      source: "marker",
    });

    const nothing = makeWorkspace("resolver-precedence-default");
    expect(await resolveSmithersBackendChoice({ cwd: nothing, env: {} })).toMatchObject({
      backend: "sqlite",
      source: "default",
    });
  });

  test("invalid backend values are rejected except malformed backend marker falls back to default", async () => {
    const explicit = makeWorkspace("resolver-invalid-explicit");
    await expect(resolveSmithersBackendChoice({ cwd: explicit, backend: "mysql", env: {} })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const env = makeWorkspace("resolver-invalid-env");
    await expect(resolveSmithersBackendChoice({ cwd: env, env: { SMITHERS_BACKEND: "foo" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const config = makeWorkspace("resolver-invalid-config");
    writeFileSync(join(config, ".smithers", "smithers.config.ts"), 'export default { backend: "foo" };\n');
    await expect(resolveSmithersBackendChoice({ cwd: config, env: {} })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const badMarker = makeWorkspace("resolver-invalid-marker");
    writeFileSync(join(badMarker, ".smithers", "backend.json"), JSON.stringify({ backend: "foo" }));
    expect(await resolveSmithersBackendChoice({ cwd: badMarker, env: {} })).toMatchObject({ backend: "sqlite", source: "default" });

    const malformedMarker = makeWorkspace("resolver-malformed-marker");
    writeFileSync(join(malformedMarker, ".smithers", "backend.json"), "{ nope");
    expect(await resolveSmithersBackendChoice({ cwd: malformedMarker, env: {} })).toMatchObject({ backend: "sqlite", source: "default" });
  });

  test("malformed smithers.config.ts throws a friendly INVALID_INPUT error", async () => {
    const cwd = makeWorkspace("resolver-malformed-config");
    writeFileSync(join(cwd, ".smithers", "smithers.config.ts"), "export default { backend: ;\n");
    await expect(resolveSmithersBackendChoice({ cwd, env: {} })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { configPath: join(cwd, ".smithers", "smithers.config.ts") },
    });
  });

  test("explicit dbPath is resolved relative to cwd and does not scan anchor sqlite paths", async () => {
    const cwd = makeWorkspace("resolver-explicit-dbpath");
    seedSqliteRuns(cwd);
    const customDbPath = "custom.db";
    seedEmptySqlite(cwd, join(cwd, customDbPath));

    const choice = await resolveSmithersBackendChoice({ cwd, dbPath: customDbPath, backend: "pglite", env: {} });
    expect(choice.dbPath).toBe(join(cwd, customDbPath));
    expect(choice.sqlite.runCount).toBe(0);
  });

  test("custom pgliteDataDir is the store probed by the resolver", async () => {
    const cwd = makeWorkspace("resolver-custom-pglite-dir");
    const customDir = join(cwd, ".smithers", "custom-pg");
    const api = await openSmithersBackend({}, { cwd, backend: "pglite", pgliteDataDir: customDir, env: {} });
    try {
      await api.db.connection.query({
        text: `
          INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status, created_at_ms)
          VALUES ('custom-pglite-run', 'wf', 'wf.tsx', 'finished', 1)
        `,
      });
    } finally {
      await closeApi(api);
    }

    const choice = await resolveSmithersBackendChoice({ cwd, backend: "pglite", pgliteDataDir: customDir, env: {} });
    expect(choice.pglite).toMatchObject({
      dataDir: customDir,
      exists: true,
      initialized: true,
      runCount: 1,
    });
  });

  test("explicit postgres connection is the store probed by the resolver", async () => {
    const cwd = makeWorkspace("resolver-custom-postgres-connection");
    const seen = [];
    const connection = {
      async query(sql) {
        const text = typeof sql === "string" ? sql : sql.text;
        seen.push(text);
        if (text.includes("to_regclass('_smithers_runs')")) return { rows: [{ table_name: "_smithers_runs" }] };
        if (text.includes("COUNT(*)::int AS count FROM _smithers_runs")) return { rows: [{ count: 3 }] };
        if (text.includes("to_regclass('_smithers_schema_migrations')")) return { rows: [{ table_name: "_smithers_schema_migrations" }] };
        if (text.includes("SELECT id FROM _smithers_schema_migrations")) return { rows: [{ id: "0018_current" }] };
        return { rows: [] };
      },
    };

    const choice = await resolveSmithersBackendChoice({ cwd, backend: "postgres", connection, env: {} });

    expect(choice.postgres).toMatchObject({
      exists: true,
      initialized: true,
      runCount: 3,
      schemaVersion: "0018",
    });
    expect(seen.some((text) => text.includes("_smithers_runs"))).toBe(true);
  });

  test("missing _smithers_runs table and corrupt sqlite files are treated as empty probes", async () => {
    const noRuns = makeWorkspace("resolver-no-runs-table");
    seedEmptySqlite(noRuns);
    expect((await resolveSmithersBackendChoice({ cwd: noRuns, env: {} })).sqlite.runCount).toBe(0);

    const corrupt = makeWorkspace("resolver-corrupt-sqlite");
    writeFileSync(join(corrupt, "smithers.db"), "not a sqlite database");
    const choice = await resolveSmithersBackendChoice({ cwd: corrupt, env: {} });
    expect(choice.sqlite.exists).toBe(true);
    expect(choice.sqlite.runCount).toBe(0);
  });

  test("schema version defaults to 0000 when sqlite migrations table is missing or empty", async () => {
    for (const variant of ["missing", "empty"]) {
      const cwd = makeWorkspace(`resolver-schema-${variant}`);
      const sqlite = new Database(join(cwd, "smithers.db"));
      sqlite.exec(`
        CREATE TABLE _smithers_runs (
          run_id TEXT PRIMARY KEY,
          workflow_name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
          VALUES ('sqlite-run', 'wf', 'finished', 1);
        ${variant === "empty" ? "CREATE TABLE _smithers_schema_migrations (id TEXT PRIMARY KEY);" : ""}
      `);
      sqlite.close();
      await expect(resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} })).rejects.toMatchObject({
        code: "SMITHERS_MIGRATION_REQUIRED",
        details: { schemaVersion: "0000" },
      });
    }
  });

  test("legacy nested .smithers/smithers.db is included in migration guard when dbPath is implicit", async () => {
    const cwd = makeWorkspace("resolver-nested-sqlite");
    const nested = join(cwd, ".smithers", "smithers.db");
    seedSqliteRuns(cwd, nested);
    await expect(resolveSmithersBackendChoice({ cwd, backend: "pglite", env: {} })).rejects.toMatchObject({
      code: "SMITHERS_MIGRATION_REQUIRED",
      details: { dbPath: nested, runCount: 1 },
    });
  });
});
