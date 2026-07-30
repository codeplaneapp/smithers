import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

test("up persists flat run annotations for durable sidecar identity", () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  writeTestWorkflow(repo);

  const result = runSmithers(
    [
      "up",
      "workflow.tsx",
      "--run-id",
      "annotated-run",
      "--annotations",
      JSON.stringify({ smithersMonitorFor: "watched-run", healthy: true }),
    ],
    {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 90_000,
    },
  );
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

  const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
  try {
    const row = sqlite.query("SELECT config_json FROM _smithers_runs WHERE run_id = ?").get("annotated-run");
    expect(JSON.parse(row.config_json).annotations).toEqual({
      smithersMonitorFor: "watched-run",
      healthy: true,
    });
  } finally {
    sqlite.close();
  }
});
