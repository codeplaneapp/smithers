import { expect, setDefaultTimeout, test } from "bun:test";
import { delimiter } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

setDefaultTimeout(180_000);

/**
 * Every legacy-inline init-pack workflow now ends with a deterministic `output`
 * task so a finished run prints a useful aggregated result instead of the noisy
 * `output: null` it used to. `seeded-workflows-graph.e2e` guards the LOAD path
 * (the output task is conditional on a prior task's output, so it is absent from
 * the first rendered frame). This drives two representative legacy workflows to
 * completion against the fake agent and asserts the terminal output task
 * actually fired and surfaced its aggregate — the only way to exercise the
 * compute closure the graph guard cannot reach.
 */
function setup() {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  const repo = createTempRepo();
  const env = {
    HOME: repo.dir,
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "sk-test-openai-key",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
  return { repo, env };
}

test("single-task legacy workflow (plan) ends with a deterministic output task, not output: null", () => {
  const { repo, env } = setup();
  const run = runSmithers(["workflow", "run", "plan", "--run-id", "plan-out"], {
    cwd: repo.dir,
    env,
    format: "json",
    timeoutMs: 180_000,
  });
  expect(run.exitCode).toBe(0);
  expect(run.json.status).toBe("finished");
  // The terminal output task derives `stepCount` from the plan it read — a field
  // the raw plan task never produces — so its presence proves the output task
  // ran and became the run's surfaced output.
  expect(run.json.output).toBeDefined();
  expect(Array.isArray(run.json.output.steps)).toBe(true);
  expect(run.json.output.stepCount).toBe(run.json.output.steps.length);
});

test("component-based legacy workflow (review) aggregates reviewer verdicts in its output task", () => {
  const { repo, env } = setup();
  const run = runSmithers(["workflow", "run", "review", "--run-id", "review-out"], {
    cwd: repo.dir,
    env,
    format: "json",
    timeoutMs: 180_000,
  });
  expect(run.exitCode).toBe(0);
  expect(run.json.status).toBe("finished");
  // The output task counts reviewers and folds their verdicts — fields no single
  // reviewer's output carries — so they prove the aggregate task fired.
  expect(run.json.output).toBeDefined();
  expect(run.json.output.reviewers).toBeGreaterThanOrEqual(1);
  expect(typeof run.json.output.approved).toBe("boolean");
  expect(typeof run.json.output.totalIssues).toBe("number");
});

test("validation-loop legacy workflow (implement) surfaces files changed + verdicts in its output task", () => {
  const { repo, env } = setup();
  const run = runSmithers(["workflow", "run", "implement", "--run-id", "implement-out"], {
    cwd: repo.dir,
    env,
    format: "json",
    timeoutMs: 180_000,
  });
  expect(run.exitCode).toBe(0);
  expect(run.json.status).toBe("finished");
  // The output task reads the last implement attempt plus the validate + review
  // verdicts the ValidationLoop produced — the aggregated shape (filesChanged +
  // allTestsPassing + approved) is what no single inner task emits together.
  expect(run.json.output).toBeDefined();
  expect(Array.isArray(run.json.output.filesChanged)).toBe(true);
  expect(typeof run.json.output.allTestsPassing).toBe("boolean");
  expect(typeof run.json.output.approved).toBe("boolean");
});
