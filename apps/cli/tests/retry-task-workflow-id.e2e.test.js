import { expect, test } from "bun:test";

import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

test("retry-task resolves a discovered workflow ID before looking up the node", () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/retryable.tsx");

  const result = runSmithers(["retry-task", "retryable", "--run-id", "missing-run", "--node-id", "missing-node"], {
    cwd: repo.dir,
    format: "json",
    env: { SMITHERS_NO_SKILL_REFRESH: "1" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    success: false,
    error: "Node not found: missing-run/missing-node/0",
  });
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("Cannot find module");
}, 30_000);
