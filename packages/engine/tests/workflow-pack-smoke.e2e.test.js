import { expect, test } from "bun:test";
import { delimiter } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../smithers/tests/e2e-helpers.js";
const WORKFLOW_PACK_SMOKE_TIMEOUT_MS = 30_000;
/**
 * @param {string} homeDir
 */
function buildWorkflowPackEnv(homeDir) {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  return {
    HOME: homeDir,
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: "",
    // Empty so Codex resolves subscription auth from .codex/auth.json below
    // instead of probing a fake env key against the real OpenAI API (401 →
    // non-retryable Codex preflight failure). The seeded implement workflow
    // leads with Codex (the "fable sandwich"), so its first task must
    // authenticate. Mirrors the canonical seeded-workflows-run.e2e setup.
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}
function initWorkflowPack(repo = createTempRepo()) {
  const env = buildWorkflowPackEnv(repo.dir);
  repo.write(".claude/.credentials.json", "{}\n");
  // ChatGPT subscription auth: a tokens.access_token makes Codex preflight
  // pass in subscription mode (no network probe), like a logged-in codex CLI.
  repo.write(
    ".codex/auth.json",
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { access_token: "fake-access-token", account_id: "acct_test" },
    }) + "\n",
  );
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  const initResult = runSmithers(["init"], {
    cwd: repo.dir,
    format: "json",
    env,
  });
  expect(initResult.exitCode).toBe(0);
  return { repo, env };
}
test(
  "curated init pack discovers every public workflow",
  () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(["workflow", "list"], {
      cwd: repo.dir,
      format: "json",
      env,
    });
    expect(result.exitCode).toBe(0);
    const ids = (result.json?.workflows ?? result.json ?? []).map((workflow) => workflow.id ?? workflow.name);
    expect(ids.sort()).toEqual([
      "create-skill",
      "create-workflow",
      "docs-driven-development",
      "smithers-repo-federation",
      "whole-foods-meal-planner",
    ]);
    expect(ids).not.toContain("implement");
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("plan");
    expect(ids).not.toContain("improve-test-coverage");
  },
  WORKFLOW_PACK_SMOKE_TIMEOUT_MS,
);
