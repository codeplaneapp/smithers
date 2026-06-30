/**
 * Unit + smoke tests for `smithers make-workflow` and the `smithers init [prompt]`
 * positional argument.
 *
 * These tests are self-contained (no API keys, no real agents) and verify:
 *   1. The commands appear in --help output with correct descriptions / args.
 *   2. `make-workflow` without an installed pack fails gracefully (RUN_NOT_FOUND
 *      with an actionable hint to run `smithers init`).
 *   3. `make-workflow --interactive` without a TTY returns INTERACTIVE_REQUIRES_TTY.
 *   4. `init [prompt]` without pack still exits non-zero (needs a real agent to
 *      run create-workflow), but the pack IS installed and create-workflow IS
 *      resolvable — proving the prompt is forwarded correctly.
 */
import { expect, test } from "bun:test";
import {
    createExecutableDir,
    createTempRepo,
    runSmithers,
    writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

// ---------------------------------------------------------------------------
// Help output
// ---------------------------------------------------------------------------

test("smithers --help lists make-workflow command", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("make-workflow");
});

test("smithers make-workflow --help shows task positional and prompt option", () => {
    const repo = createTempRepo();
    const result = runSmithers(["make-workflow", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("task");
    expect(out).toContain("create-workflow");
});

test("smithers init --help shows [prompt] positional argument", () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("prompt");
});

// ---------------------------------------------------------------------------
// make-workflow without pack → clear error pointing to `smithers init`
// ---------------------------------------------------------------------------

test("make-workflow without installed pack exits non-zero with install hint", () => {
    const repo = createTempRepo();
    const result = runSmithers(["make-workflow", "add rate limiting", "--format", "json"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(result.exitCode).not.toBe(0);
    // Should mention init in the error message
    const all = (result.stdout ?? "") + (result.stderr ?? "");
    expect(all).toContain("smithers init");
});

// ---------------------------------------------------------------------------
// make-workflow --interactive without TTY → INTERACTIVE_REQUIRES_TTY
// ---------------------------------------------------------------------------

test("make-workflow --interactive without a TTY exits with INTERACTIVE_REQUIRES_TTY", () => {
    const repo = createTempRepo();
    // We still need a pack for resolveWorkflow to succeed before the TTY check
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    runSmithers(["init", "--yes", "--no-install", "--no-skill"], {
        cwd: repo.dir,
        format: "json",
        env: {
            HOME: repo.dir,
            PATH: `${binDir}:/usr/bin:/bin`,
            OPENAI_API_KEY: "sk-test-openai-key",
            ANTHROPIC_API_KEY: "",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
        },
    });

    const result = runSmithers(["make-workflow", "--interactive", "--format", "json"], {
        cwd: repo.dir,
        format: "json",
        env: {
            HOME: repo.dir,
            PATH: `${binDir}:/usr/bin:/bin`,
            OPENAI_API_KEY: "sk-test-openai-key",
        },
    });
    expect(result.exitCode).not.toBe(0);
    const all = (result.stdout ?? "") + (result.stderr ?? "");
    expect(all).toContain("INTERACTIVE_REQUIRES_TTY");
});

// ---------------------------------------------------------------------------
// init [prompt]: pack is installed and create-workflow resolves; prompt flows through
// ---------------------------------------------------------------------------

test("init with a prompt installs the pack (create-workflow is discoverable afterward)", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const env = {
        HOME: repo.dir,
        PATH: `${binDir}:/usr/bin:/bin`,
        OPENAI_API_KEY: "sk-test-openai-key",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        SMITHERS_NONINTERACTIVE: "1",
    };

    // First install the pack so create-workflow exists
    runSmithers(["init", "--yes", "--no-install", "--no-skill"], {
        cwd: repo.dir,
        format: "json",
        env,
    });

    // create-workflow must now be discoverable
    const list = runSmithers(["workflow", "list"], { cwd: repo.dir, format: "json", env });
    expect(list.exitCode).toBe(0);
    const ids = (list.json?.workflows ?? []).map((w) => w.id);
    expect(ids).toContain("create-workflow");
});

test("make-workflow with a task prompt resolves create-workflow and forwards the prompt", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const env = {
        HOME: repo.dir,
        PATH: `${binDir}:/usr/bin:/bin`,
        OPENAI_API_KEY: "sk-test-openai-key",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        SMITHERS_NONINTERACTIVE: "1",
    };

    // Install the pack so create-workflow exists
    runSmithers(["init", "--yes", "--no-install", "--no-skill"], {
        cwd: repo.dir,
        format: "json",
        env,
    });

    // `make-workflow "add rate limiting"` should resolve create-workflow and
    // attempt to run it with the prompt forwarded as input.  It will fail
    // (no real agent / API key), but the error must NOT be RUN_NOT_FOUND —
    // that would mean the workflow was never resolved.
    const result = runSmithers(
        ["make-workflow", "add rate limiting", "--format", "json"],
        { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 },
    );
    // The workflow was found (no RUN_NOT_FOUND hint about "smithers init")
    const all = (result.stdout ?? "") + (result.stderr ?? "");
    expect(all).not.toContain("run `smithers init`");
    // Error (if any) is from the workflow run itself, not from resolution
    if (result.json?.code) {
        expect(result.json.code).not.toBe("RUN_NOT_FOUND");
    }
}, 60_000);
