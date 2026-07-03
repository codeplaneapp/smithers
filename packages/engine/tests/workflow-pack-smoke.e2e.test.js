import { expect, test } from "bun:test";
import { delimiter } from "node:path";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeAntigravityBinary, writeFakeClaudeBinary, } from "../../smithers/tests/e2e-helpers.js";
const WORKFLOW_PACK_SMOKE_TIMEOUT_MS = 30_000;
/**
 * @param {string} homeDir
 */
function buildWorkflowPackEnv(homeDir) {
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
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
test("seeded implement workflow runs end-to-end and writes logs under .smithers/executions", () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(["workflow", "implement", "--prompt", "hello"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        status: "finished",
    });
    const runId = result.json?.runId;
    expect(typeof runId).toBe("string");
    expect(repo.exists(`.smithers/executions/${runId}/logs`)).toBe(true);
}, WORKFLOW_PACK_SMOKE_TIMEOUT_MS);
test("seeded review workflow runs end-to-end with fake agents", () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(["workflow", "review", "--prompt", "hello"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        status: "finished",
    });
}, WORKFLOW_PACK_SMOKE_TIMEOUT_MS);
test("seeded plan workflow runs end-to-end with fake agents", () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(["workflow", "plan", "--prompt", "hello"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        status: "finished",
    });
}, WORKFLOW_PACK_SMOKE_TIMEOUT_MS);
test("seeded improve-test-coverage workflow resolves and runs end-to-end", () => {
    const { repo, env } = initWorkflowPack();
    const result = runSmithers(["workflow", "improve-test-coverage", "--prompt", "hello"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
        status: "finished",
    });
}, WORKFLOW_PACK_SMOKE_TIMEOUT_MS);
