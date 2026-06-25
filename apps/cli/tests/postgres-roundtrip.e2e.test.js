import { expect, setDefaultTimeout, test } from "bun:test";
import { openSmithersStore } from "../../../packages/smithers/src/openSmithersStore.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

setDefaultTimeout(120_000);

const PG_URL = process.env.SMITHERS_TEST_PG_URL;

function quoteId(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function tempDbName(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function urlForDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withTempPostgresDatabase(fn) {
  const database = tempDbName("smithers_cli_pg");
  const pg = await import("../../../packages/smithers/node_modules/pg/lib/index.js");
  const Client = pg.default?.Client ?? pg.Client;
  const admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteId(database)}`);
  await admin.end();

  const url = urlForDatabase(PG_URL, database);
  try {
    return await fn(url);
  } finally {
    const cleanup = new Client({ connectionString: PG_URL });
    await cleanup.connect();
    await cleanup.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    ).catch(() => {});
    await cleanup.query(`DROP DATABASE IF EXISTS ${quoteId(database)}`).catch(() => {});
    await cleanup.end().catch(() => {});
  }
}

function writePostgresWorkflow(repo) {
  repo.write(".smithers/workflows/postgres-roundtrip.tsx", [
    "/** @jsxImportSource smithers-orchestrator */",
    'import { openSmithersBackend, Workflow, Task } from "smithers-orchestrator";',
    'import { z } from "zod";',
    "",
    "const { smithers, outputs } = await openSmithersBackend({",
    "  result: z.object({",
    "    summary: z.string(),",
    "    prompt: z.string().nullable(),",
    "  }),",
    "});",
    "",
    "export default smithers((ctx) => (",
    '  <Workflow name="postgres-roundtrip">',
    '    <Task id="write-result" output={outputs.result}>',
    "      {{",
    '        summary: "fixture workflow ran in postgres",',
    "        prompt: ctx.input.prompt ?? null,",
    "      }}",
    "    </Task>",
    "  </Workflow>",
    "));",
    "",
  ].join("\n"));
}

const maybeTest = PG_URL ? test : test.skip;

maybeTest("postgres init/run/read round-trip uses the real Postgres store", async () => {
  await withTempPostgresDatabase(async (connectionString) => {
    const repo = createTempRepo();
    writePostgresWorkflow(repo);

    const env = {
      SMITHERS_BACKEND: "postgres",
      SMITHERS_POSTGRES_URL: connectionString,
    };

    const run = runSmithers(["workflow", "run", "postgres-roundtrip", "--run-id", "postgres-roundtrip"], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
    expect(run.json.status).toBe("finished");

    const ps = runSmithers(["ps"], { cwd: repo.dir, env, format: "json", timeoutMs: 120_000 });
    expect(ps.exitCode).toBe(0);
    expect(ps.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
    expect(JSON.stringify(ps.json)).toContain("postgres-roundtrip");

    const inspect = runSmithers(["inspect", "postgres-roundtrip"], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json.run.id).toBe("postgres-roundtrip");

    const output = runSmithers(["output", "postgres-roundtrip", "write-result"], {
      cwd: repo.dir,
      env,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("fixture workflow ran in postgres");

    const opened = await openSmithersStore({
      cwd: repo.dir,
      backend: "postgres",
      connectionString,
      mode: "read",
      env: {},
    });
    try {
      expect(opened.choice.backend).toBe("postgres");
      expect(opened.choice.postgres.runCount).toBe(1);
      const runRecord = await opened.adapter.getRun("postgres-roundtrip");
      expect(runRecord?.runId).toBe("postgres-roundtrip");
    } finally {
      await opened.cleanup?.();
    }
  });
});
