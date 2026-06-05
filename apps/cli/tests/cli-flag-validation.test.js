// Tests for CLI input/flag validation that doesn't require a workflow.
//
// Each scenario uses runSmithers (a real Bun subprocess) so the tests
// observe what an end user would observe — the same argv parsing path,
// the same error rendering, and the same exit codes. We only stress
// behaviors that require neither a runnable workflow nor a working
// node_modules tree, so these stay green even in worktrees that lack
// full e2e dependencies.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

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

    test("--resume-claim-owner without --heartbeat fails before workflow load", () => {
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

    test("unknown subcommand exits non-zero", () => {
        const repo = createTempRepo();
        const result = runSmithers(["totally-not-a-real-subcommand"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Unknown command");
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

describe("--input streaming via stdin", () => {
    test("`--input -` reads small JSON from stdin", () => {
        const repo = createTempRepo();
        writeTestWorkflow(repo);
        const result = runSmithers(["up", "workflow.tsx", "--input", "-"], {
            cwd: repo.dir,
            format: "json",
            stdin: JSON.stringify({ prompt: "from stdin" }),
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ status: "finished" });
        const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
        try {
            const row = sqlite.query('select prompt from "result" order by rowid desc limit 1').get();
            expect(row?.prompt).toBe("from stdin");
        }
        finally {
            sqlite.close();
        }
    });

    test("malformed stdin JSON yields INVALID_JSON", () => {
        const repo = createTempRepo();
        const result = runSmithers(["up", "fake-workflow.tsx", "--input", "-"], {
            cwd: repo.dir,
            format: null,
            stdin: "{not-json",
        });
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("INVALID_JSON");
    });

    test("stdin over 1MB is rejected at the documented limit", () => {
        const repo = createTempRepo();
        const result = runSmithers(["up", "fake-workflow.tsx", "--input", "-"], {
            cwd: repo.dir,
            format: null,
            stdin: JSON.stringify({ payload: "x".repeat(1024 * 1024 + 1) }),
        });
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("input");
    });
});

describe("--annotations streaming via stdin", () => {
    test("detached runs serialize `--annotations -` before spawning the child", async () => {
        const repo = createTempRepo();
        writeTestWorkflow(repo);
        const result = runSmithers(["up", "workflow.tsx", "--detach", "--annotations", "-"], {
            cwd: repo.dir,
            format: "json",
            stdin: JSON.stringify({ channel: "ops" }),
        });
        expect(result.exitCode).toBe(0);
        expect(result.json?.runId).toBeString();
        expect(result.json?.logFile).toBeString();

        let status;
        for (let attempt = 0; attempt < 240; attempt += 1) {
            if (existsSync(repo.path("smithers.db"))) {
                const sqlite = new Database(repo.path("smithers.db"), { readonly: true });
                try {
                    try {
                        status = sqlite.query("select status from _smithers_runs where run_id = ?").get(result.json.runId)?.status;
                    }
                    catch (err) {
                        if (!String(err?.message ?? err).includes("no such table: _smithers_runs")) {
                            throw err;
                        }
                    }
                }
                finally {
                    sqlite.close();
                }
                if (status && status !== "running") {
                    break;
                }
            }
            await Bun.sleep(50);
        }
        expect(status).toBe("finished");
        expect(readFileSync(result.json.logFile, "utf8")).not.toContain("INVALID_JSON");
    }, 15_000);
});
