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
    // Leave OPENAI_API_KEY empty so Codex resolves subscription auth from the
    // auth.json below instead of probing a fake env key against the real OpenAI
    // API (which returns 401 and hard-fails Codex preflight). The `implement`
    // workflow leads its first task with Codex (the "fable sandwich"), so a
    // single-agent Codex task must authenticate — a non-retryable preflight
    // auth failure would fail the run before it can fall over to Sonnet. This
    // mirrors the canonical seeded-workflows-run.e2e setup.
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  // ChatGPT subscription auth: presence of a tokens.access_token makes Codex
  // preflight pass in subscription mode (no network probe), matching how a
  // logged-in `codex` CLI authenticates.
  repo.write(
    ".codex/auth.json",
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "fake-access-token", account_id: "acct_test" },
    }) + "\n",
  );
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
  return { repo, env };
}

test.skip("single-task legacy workflow (plan) ends with a deterministic output task, not output: null", () => {
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
  // ran. Machine JSON preserves the raw output-table row array.
  expect(Array.isArray(run.json.output)).toBe(true);
  const output = run.json.output[0];
  expect(Array.isArray(output.steps)).toBe(true);
  expect(output.stepCount).toBe(output.steps.length);
});

test.skip("component-based legacy workflow (review) aggregates reviewer verdicts in its output task", () => {
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
  expect(Array.isArray(run.json.output)).toBe(true);
  const output = run.json.output[0];
  expect(output.reviewers).toBeGreaterThanOrEqual(1);
  expect(typeof output.approved).toBe("boolean");
  expect(typeof output.totalIssues).toBe("number");
});

test.skip("validation-loop legacy workflow (implement) surfaces files changed + verdicts in its output task", () => {
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
  expect(Array.isArray(run.json.output)).toBe(true);
  const output = run.json.output[0];
  expect(Array.isArray(output.filesChanged)).toBe(true);
  expect(typeof output.allTestsPassing).toBe("boolean");
  expect(typeof output.approved).toBe("boolean");
});
