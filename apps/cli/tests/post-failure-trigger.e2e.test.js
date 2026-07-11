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

setDefaultTimeout(240_000);

const POST_FAILURE_AGENT_RESPONSE = JSON.stringify({
    rootCause: "The fixture workflow's compute task throws its deliberate test error.",
    failureClass: "workflow-bug",
    confidence: "high",
    evidence: ["The boom task reports the deliberate failure from fail.tsx."],
    suggestion: "edit-workflow-and-reset",
    suggestionDetail: "Remove the deliberate throw before starting a fresh run.",
    commands: ["bunx smithers-orchestrator workflow run fail-demo"],
    bugTitle: "",
    bugBody: "",
});

function runStatus(row) {
    return String(row?.status ?? row?.runState ?? "");
}

function isTerminalStatus(status) {
    return status === "finished" || status === "failed" || status === "cancelled" || status === "continued";
}

async function waitForRun(repo, env, runId, { timeoutMs = 90_000, terminal = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ps = runSmithers(["ps", "--all", "--limit", "50"], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 60_000,
            env,
        });
        const runs = Array.isArray(ps.json) ? ps.json : (ps.json?.runs ?? []);
        const row = runs.find((candidate) => String(candidate.id ?? candidate.runId ?? "") === runId);
        if (row && (!terminal || isTerminalStatus(runStatus(row)))) return row;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
}

/**
 * E2E for the CLI-level post-failure auto-trigger (launchPostFailureAutopsy):
 * a failed run auto-launches the installed `post-failure` workflow detached,
 * `--no-post-failure` / SMITHERS_POST_FAILURE=0 opt out, ops workflows never
 * recurse, and a missing `post-failure` workflow degrades to a manual CTA.
 * Real CLI, real temp store, no mocks; the deliberate failure is a compute
 * task that throws with retries={0}, so no agent CLI is needed for the
 * failing run itself.
 */
function failingWorkflowSource(name = "fail-demo") {
    return [
        "/** @jsxImportSource smithers-orchestrator */",
        'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
        'import { z } from "zod";',
        "",
        "const { smithers, outputs } = createSmithers({",
        "  result: z.object({ ok: z.boolean() }),",
        "});",
        "",
        "export default smithers(() => (",
        `  <Workflow name="${name}">`,
        '    <Task id="boom" output={outputs.result} retries={0}>',
        '      {() => { throw new Error("deliberate failure for the autopsy trigger test"); }}',
        "    </Task>",
        "  </Workflow>",
        "));",
        "",
    ].join("\n");
}

test("failed run without an installed post-failure workflow prints the manual CTA", () => {
    const repo = createTempRepo();
    repo.write("fail.tsx", failingWorkflowSource());
    const run = runSmithers(["up", "fail.tsx", "--run-id", "fail-cta"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(1);
    expect(run.json.status).toBe("failed");
    expect(run.stderr).toContain(
        `smithers workflow run post-failure --input '{"targetRunId":"fail-cta"}'`,
    );
    expect(run.stderr).not.toContain("autopsy launched");
});

test("--no-post-failure suppresses the trigger entirely", () => {
    const repo = createTempRepo();
    repo.write("fail.tsx", failingWorkflowSource());
    const run = runSmithers(["up", "fail.tsx", "--run-id", "fail-flag", "--no-post-failure"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(1);
    expect(run.json.status).toBe("failed");
    expect(run.stderr).not.toContain("post-failure");
});

test("SMITHERS_POST_FAILURE=0 suppresses the trigger entirely", () => {
    const repo = createTempRepo();
    repo.write("fail.tsx", failingWorkflowSource());
    const run = runSmithers(["up", "fail.tsx", "--run-id", "fail-env"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
        env: { SMITHERS_POST_FAILURE: "0" },
    });
    expect(run.exitCode).toBe(1);
    expect(run.json.status).toBe("failed");
    expect(run.stderr).not.toContain("post-failure");
});

test("a failing post-failure run itself never triggers another autopsy (recursion guard)", () => {
    const repo = createTempRepo();
    // A workflow whose id is `post-failure` (by filename) that fails: the
    // recursion guard must skip the trigger before it even checks installation.
    repo.write(".smithers/workflows/post-failure.tsx", failingWorkflowSource("post-failure"));
    const run = runSmithers(
        ["up", ".smithers/workflows/post-failure.tsx", "--run-id", "fail-recursion"],
        { cwd: repo.dir, format: "json", timeoutMs: 120_000 },
    );
    expect(run.exitCode).toBe(1);
    expect(run.json.status).toBe("failed");
    expect(run.stderr).not.toContain("autopsy launched");
    expect(run.stderr).not.toContain("workflow run post-failure");
});

test("failed run auto-launches the installed post-failure workflow detached", async () => {
    // Full init so the REAL seeded post-failure workflow is installed. CI has
    // no agent CLIs, so seed the fake agent binaries (same as init.e2e).
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    writeFakeCodexBinary(binDir);
    writeFakeAntigravityBinary(binDir);
    const repo = createTempRepo();
    const env = {
        HOME: repo.dir,
        PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        SMITHERS_FAKE_AGENT_RESPONSE: POST_FAILURE_AGENT_RESPONSE,
    };
    repo.write(".claude/.credentials.json", "{}\n");
    // Subscription-shaped auth keeps Codex diagnostics hermetic: the fake CLI
    // is selected without probing the public API with a placeholder key.
    repo.write(".codex/auth.json", '{"tokens":{"access_token":"test-subscription-token"}}\n');
    repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
    expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
    expect(repo.exists(".smithers/workflows/post-failure.tsx")).toBe(true);

    repo.write("fail.tsx", failingWorkflowSource());
    let autopsyRunId = null;
    let terminalRow = null;
    try {
        const run = runSmithers(["up", "fail.tsx", "--run-id", "fail-auto"], {
            cwd: repo.dir,
            format: "json",
            timeoutMs: 120_000,
            env,
        });
        expect(run.exitCode).toBe(1);
        expect(run.json.status).toBe("failed");
        const match = run.stderr.match(/Post-failure autopsy launched: (post-failure-[a-z0-9-]+)\./);
        expect(match).not.toBeNull();
        autopsyRunId = match[1];
        expect(run.stderr).toContain(`smithers inspect ${autopsyRunId}`);

        // Registration alone is not enough: teardown removes this fixture's
        // workflow, fake-agent binaries, DB, and log. Wait for the detached
        // process to finish so it cannot outlive those resources.
        terminalRow = await waitForRun(repo, env, autopsyRunId, { terminal: true });
        expect(terminalRow).not.toBeNull();
        expect(runStatus(terminalRow)).toBe("finished");
        // The engine clears its supervisor after persisting terminal state.
        // Give that finalizer one polling interval before fixture teardown.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    finally {
        if (autopsyRunId && !isTerminalStatus(runStatus(terminalRow))) {
            runSmithers(["cancel", autopsyRunId], {
                cwd: repo.dir,
                format: "json",
                timeoutMs: 30_000,
                env,
            });
            await waitForRun(repo, env, autopsyRunId, { timeoutMs: 15_000, terminal: true });
        }
    }
});
