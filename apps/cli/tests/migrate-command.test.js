import { expect, test } from "bun:test";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createServer } from "node:net";
import { createSmithers } from "../../../packages/smithers/src/create.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

function seedLegacyStore(repo) {
  repo.write(".smithers/smithers.config.ts", "export default {};\n");
  const dbPath = repo.path("smithers.db");
  const api = createSmithers({}, { dbPath, backend: "sqlite" });
  ensureSmithersTables(api.db);
  api.db.$client.exec(`
    INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
      VALUES ('cli-migrate-run', 'cli-migrate-fixture', 'finished', 1);
    INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
      VALUES ('cli-migrate-run', 1, 1, 'RunStarted', '{"runId":"cli-migrate-run"}');
  `);
  const row = api.db.$client
    .query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1")
    .get();
  const schemaVersion = String(row?.id ?? "0000").match(/^\d+/)?.[0] ?? "0000";
  api.db.$client.close();
  return { dbPath, schemaVersion };
}

async function findOpenPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate an open port");
  }
  return address.port;
}

test("smithers migrate copies the legacy sqlite store to PGlite and writes migrated.json", () => {
  const repo = createTempRepo();
  const { dbPath } = seedLegacyStore(repo);

  const result = runSmithers(["migrate", "--to", "pglite"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 120_000,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("migrated _smithers_runs: 1/1 rows");
  expect(repo.exists(".smithers/migrated.json")).toBe(true);
  expect(repo.exists("smithers.db")).toBe(true);
  expect(result.json?.data?.dbPath ?? result.json?.dbPath).toBe(dbPath);
});

test("smithers gateway fails loud for a legacy sqlite store before migration", async () => {
  const repo = createTempRepo();
  const { schemaVersion } = seedLegacyStore(repo);
  const port = await findOpenPort();

  const result = runSmithers(["gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 30_000,
  });

  expect(result.exitCode).toBe(4);
  const combined = `${result.stdout}\n${result.stderr}`;
  expect(combined).toContain("SMITHERS_MIGRATION_REQUIRED");
  expect(combined).toContain("smithers.db");
  expect(combined).toContain("1 runs");
  expect(combined).toContain(`schema v${schemaVersion}`);
  expect(combined).toContain("smithers migrate");
  expect(combined).toContain("smithers <cmd> --backend sqlite");
});

test("smithers ps (a CLI read command) fails loud for a legacy sqlite store before migration", () => {
  const repo = createTempRepo();
  const { schemaVersion } = seedLegacyStore(repo);

  const result = runSmithers(["ps"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 30_000,
  });

  // No silent success: the legacy run is NOT listed; the resolver fails loud.
  expect(result.exitCode).not.toBe(0);
  const combined = `${result.stdout}\n${result.stderr}`;
  expect(combined).toContain("SMITHERS_MIGRATION_REQUIRED");
  expect(combined).toContain("smithers.db");
  expect(combined).toContain("1 runs");
  expect(combined).toContain(`schema v${schemaVersion}`);
  expect(combined).toContain("smithers migrate");
  expect(combined).not.toContain("cli-migrate-run");
});

test("SMITHERS_BACKEND=sqlite suppresses the ps migration guard and reads the legacy store", () => {
  const repo = createTempRepo();
  seedLegacyStore(repo);

  const result = runSmithers(["ps", "--all"], {
    cwd: repo.dir,
    format: "json",
    env: { SMITHERS_BACKEND: "sqlite" },
    timeoutMs: 30_000,
  });

  expect(result.exitCode).toBe(0);
  const combined = `${result.stdout}\n${result.stderr}`;
  expect(combined).not.toContain("SMITHERS_MIGRATION_REQUIRED");
  expect(JSON.stringify(result.json)).toContain("cli-migrate-run");
});

test("a present migrated.json marker suppresses the ps migration guard", () => {
  const repo = createTempRepo();
  seedLegacyStore(repo);
  repo.write(".smithers/migrated.json", JSON.stringify({ migratedAt: 1 }));

  const result = runSmithers(["ps", "--all"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 30_000,
  });

  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("SMITHERS_MIGRATION_REQUIRED");
});

test("a fresh workspace never triggers the ps migration guard", () => {
  const repo = createTempRepo();
  repo.write(".smithers/smithers.config.ts", "export default {};\n");

  const result = runSmithers(["ps"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 30_000,
  });

  // A fresh `.smithers/` has no run history, so the guard never fires.
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("SMITHERS_MIGRATION_REQUIRED");
});
