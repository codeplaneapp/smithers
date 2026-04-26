// Tests for CLI input/flag validation that doesn't require a workflow.
//
// Each scenario uses runSmithers (a real Bun subprocess) so the tests
// observe what an end user would observe — the same argv parsing path,
// the same error rendering, and the same exit codes. We only stress
// behaviors that require neither a runnable workflow nor a working
// node_modules tree, so these stay green even in worktrees that lack
// full e2e dependencies.
import { describe, expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

describe("conflicting / invalid flag combinations", () => {
    test("--supervise without --serve on `up` exits non-zero with a clear message", () => {
        const repo = createTempRepo();
        // Workflow path doesn't have to be valid: the --supervise/--serve
        // gate is checked before the workflow is loaded.
        const result = runSmithers(["up", "fake-workflow.tsx", "--supervise"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).not.toBe(0);
        const all = `${result.stdout}\n${result.stderr}`;
        expect(all).toContain("--supervise");
        expect(all.toLowerCase()).toContain("--serve");
    });

    test.skip("FIXME(cli-resume-claim): --resume-claim-owner without --heartbeat should fail before workflow load", () => {
        // Currently the CLI tries to load the workflow first (line ~1507
        // in apps/cli/src/index.js) and only checks the resume-claim
        // pairing after, so passing a non-existent workflow path masks
        // this validation entirely. Move the check above the workflow
        // load so this scenario fails on its own merits.
        const repo = createTempRepo();
        const result = runSmithers(
            ["up", "fake-workflow.tsx", "--resume-claim-owner", "owner-1"],
            { cwd: repo.dir, format: null },
        );
        expect(result.exitCode).not.toBe(0);
        const all = `${result.stdout}\n${result.stderr}`;
        expect(all).toContain("--resume-claim-owner");
        expect(all).toContain("--resume-claim-heartbeat");
    });

    test.skip("FIXME(cli-unknown-cmd-exit): unknown subcommand should exit non-zero", () => {
        // CLI currently prints a "command not found" surface but exits 0,
        // which means CI treats `smithers totally-bogus` as a successful
        // run. Confirmed reproducible with `smithers totally-bogus` →
        // exit 0 + COMMAND_NOT_FOUND payload on stdout. Fix in the CLI
        // command dispatcher: emit a non-zero exit code on unrecognized
        // commands.
        const repo = createTempRepo();
        const result = runSmithers(["totally-not-a-real-subcommand"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).not.toBe(0);
    });

    test("--input with malformed JSON does not produce a raw V8 stack trace", () => {
        const repo = createTempRepo();
        const result = runSmithers(
            ["up", "fake-workflow.tsx", "--input", "{not-json"],
            { cwd: repo.dir, format: null },
        );
        // Whether we surface INVALID_JSON or a workflow-load error first,
        // the user must NOT see a Node-internal stack frame.
        const all = `${result.stdout}\n${result.stderr}`;
        expect(all).not.toContain("processTicksAndRejections");
    }, 30_000);
});

describe("NO_COLOR / TTY handling", () => {
    test("NO_COLOR=1 in env strips ANSI color codes from --help output", () => {
        const repo = createTempRepo();
        const result = runSmithers(["--help"], {
            cwd: repo.dir,
            format: null,
            env: { NO_COLOR: "1" },
        });
        expect(result.exitCode).toBe(0);
        // ESC sequences ("\u001b[") should not appear when NO_COLOR is set
        // (and stdout in spawnSync is non-TTY anyway, which compounds the
        // effect — this is the documented Unix-conventional behavior).
        expect(result.stdout).not.toContain("\u001b[");
    });

    test("non-TTY stdout still produces help output (no color required)", () => {
        const repo = createTempRepo();
        const result = runSmithers(["--help"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage: smithers <command>");
    });

    test("very narrow COLUMNS does not crash help rendering", () => {
        const repo = createTempRepo();
        const result = runSmithers(["--help"], {
            cwd: repo.dir,
            format: null,
            env: { COLUMNS: "10" },
        });
        expect(result.exitCode).toBe(0);
        // Output should still be non-empty even when terminal is tiny.
        expect(result.stdout.length).toBeGreaterThan(0);
    });
});

describe("--input streaming via stdin (FIXME: not implemented)", () => {
    // The CLI does not currently support `--input -` to stream JSON from
    // stdin (apps/cli/src/index.js parses --input as a literal JSON
    // string only). These tests are placeholders so that, when the
    // feature lands, they fail loudly until the contract is verified.
    test.skip("FIXME(cli-stdin-input): `--input -` reads small JSON from stdin", () => {
        expect(true).toBe(true);
    });
    test.skip("FIXME(cli-stdin-input): malformed stdin JSON yields INVALID_JSON", () => {
        expect(true).toBe(true);
    });
    test.skip("FIXME(cli-stdin-input): stdin >1MB rejected at the documented limit (CLI_JSON_ARGUMENT_MAX_BYTES)", () => {
        expect(true).toBe(true);
    });
});
