import { expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const QUIET_ENV = {
  SMITHERS_NO_SKILL_REFRESH: "1",
  SMITHERS_NO_UPDATE_CHECK: "1",
};

test("ps and status resolve the parent workspace from a nested package directory", () => {
  // Project anchors are deliberately restricted to directories below the
  // user's home, so stage this walk-up fixture there instead of the OS tmpdir.
  const repo = createTempRepo({ parentDir: homedir() });
  writeTestWorkflow(repo, ".smithers/workflows/workspace-subdirectory.tsx");
  pinSqliteBackend(repo.dir);
  repo.write("packages/tooling/package.json", '{"name":"tooling","private":true}\n');

  const runId = "workspace-subdirectory";
  const launched = runSmithers(["workflow", "run", "workspace-subdirectory", "--run-id", runId], {
    cwd: repo.dir,
    env: QUIET_ENV,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(launched.exitCode, `${launched.stdout}\n${launched.stderr}`).toBe(0);
  expect(launched.json.status).toBe("finished");

  const rootPs = runSmithers(["ps"], {
    cwd: repo.dir,
    env: QUIET_ENV,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(rootPs.exitCode, `${rootPs.stdout}\n${rootPs.stderr}`).toBe(0);
  expect(
    rootPs.json.runs.some((run) => run.id === runId),
    JSON.stringify(rootPs.json),
  ).toBe(true);

  const nestedCwd = repo.path("packages", "tooling");
  const ps = runSmithers(["ps"], {
    cwd: nestedCwd,
    env: QUIET_ENV,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(ps.exitCode, `${ps.stdout}\n${ps.stderr}`).toBe(0);
  expect(
    ps.json.runs.some((run) => run.id === runId),
    JSON.stringify(ps.json),
  ).toBe(true);

  const status = runSmithers(["status", runId], {
    cwd: nestedCwd,
    env: QUIET_ENV,
    format: "json",
    timeoutMs: 120_000,
  });
  expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
  expect(status.json.runId).toBe(runId);
}, 300_000);
