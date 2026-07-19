import { expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
test("help surface advertises the ui command", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\n  ui ");
});
test("help surface advertises the review command", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("\n  review ");
});
test("review --help delegates to the review CLI help", () => {
    const repo = createTempRepo();
    const result = runSmithers(["review", "--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: smithers review [repo] [options]");
    expect(result.stdout).toContain("--pr <number|url>");
    expect(result.stdout).toContain("SMITHERS_REVIEW_ENGINE");
    expect(result.stdout).toContain("smithers review --from main --to HEAD");
});
test("monitor --help describes the live all-runs web UI, not a workflow", () => {
    const repo = createTempRepo();
    const result = runSmithers(["monitor", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("live web UI over every run");
    expect(result.stdout).toContain("--no-open");
    expect(result.stdout).not.toContain("autofix");
});
test("root help documents the global --json shorthand and its command-scoped exceptions (#11)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--json is accepted on every command as shorthand for `--format json`");
    // The command-scoped set must be spelled out so callers know where the
    // spelling changes meaning.
    for (const cmd of ["events", "timeline", "tree", "diff", "output", "rewind", "snapshots", "restore"]) {
        expect(result.stdout).toContain(cmd);
    }
});
test("tree --help binds -w to --watch like ps/events/inspect/node (#10)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["tree", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--watch, -w");
});
test("logs --help offers --from-seq and marks --since as the deprecated sequence-number alias (#10)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["logs", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--from-seq");
    expect(result.stdout).toContain("SEQUENCE NUMBER");
    expect(result.stdout).toContain("duration window");
});
test("events --help says --since is a duration and distinguishes it from logs --since (#10)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["events", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("duration window");
    expect(result.stdout).toContain("milliseconds");
    expect(result.stdout).toContain("--replay-history");
});
test("hijack --help documents --target as engine OR node id (#23)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["hijack", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("or node id");
    expect(result.stdout).not.toContain("Expected agent engine");
});
test("gui --help describes what it actually opens: the most recent run's workflow UI (#13)", () => {
    const repo = createTempRepo();
    const result = runSmithers(["gui", "--help"], { cwd: repo.dir, format: null });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MOST RECENT run's workflow UI");
    expect(result.stdout).not.toContain("Open a directory as a workspace in Smithers UI");
});
