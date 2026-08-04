// `smithers up --resume <runId>` with no workflow arg must derive the workflow
// from the stored run record instead of failing WORKFLOW_REQUIRED (issue #1475).
//
// Scenarios drive the real CLI as a Bun subprocess against a real
// sqlite-backed workspace — no mocks anywhere.
import { describe, expect, test } from "bun:test";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

describe("up --resume <runId> derives the workflow from the run record (#1475)", () => {
  test("unknown run id fails RUN_NOT_FOUND, not WORKFLOW_REQUIRED", () => {
    const repo = createTempRepo();
    const result = runSmithers(["up", "--resume", "run-does-not-exist"], { cwd: repo.dir, format: "json" });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("RUN_NOT_FOUND");
    expect(result.json.message).toContain("run-does-not-exist");
  });

  test("resuming a recorded run without a workflow arg relaunches its stored workflow", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    writeTestWorkflow(repo);

    const first = runSmithers(["up", "workflow.tsx", "--run-id", "resume-derive-run"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);

    // The exact shape from the bug report: --resume <runId>, no workflow arg.
    const resumed = runSmithers(["up", "--resume", "resume-derive-run", "--force"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(resumed.exitCode, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(resumed.json.runId).toBe("resume-derive-run");
  });
});
