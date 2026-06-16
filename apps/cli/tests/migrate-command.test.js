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
  api.db.$client.close();
  return dbPath;
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
  const dbPath = seedLegacyStore(repo);

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
  seedLegacyStore(repo);
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
  expect(combined).toContain("schema v0016");
  expect(combined).toContain("smithers migrate");
  expect(combined).toContain("smithers <cmd> --backend sqlite");
});
