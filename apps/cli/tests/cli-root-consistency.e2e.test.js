import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createTempRepo, runSmithers, writeTestWorkflow, } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Regression coverage for #283: the effective task root must not drift between
 * the different ways of launching the same local workflow. The fixture is a pure
 * compute Task, so each run finishes in milliseconds without any agent.
 */

const WF_PATH = ".smithers/workflows/root-repro.tsx";

test("up <path> and workflow run <name> resolve the same task root", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, WF_PATH);

    const byPath = runSmithers(["up", WF_PATH, "--run-id", "by-path"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(byPath.exitCode).toBe(0);
    expect(byPath.json.status).toBe("finished");

    const byName = runSmithers(["workflow", "run", "root-repro", "--run-id", "by-name"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(byName.exitCode).toBe(0);
    expect(byName.json.status).toBe("finished");

    const inspectPath = runSmithers(["inspect", "by-path"], { cwd: repo.dir, format: "json" });
    const inspectName = runSmithers(["inspect", "by-name"], { cwd: repo.dir, format: "json" });
    expect(inspectPath.exitCode).toBe(0);
    expect(inspectName.exitCode).toBe(0);

    const rootByPath = inspectPath.json.config?.rootDir;
    const rootByName = inspectName.json.config?.rootDir;

    // Both launch forms anchor to the project root (the repo we ran from), not to
    // `.smithers/workflows/` (the old `up <path>` default) or a divergent CWD.
    expect(rootByPath).toBe(repo.dir);
    expect(rootByName).toBe(repo.dir);
    expect(rootByPath).toBe(rootByName);
});

test("graph accepts --root (parity with up) and renders", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, WF_PATH);

    // Previously `graph` rejected --root because graphOptions had no `root` field.
    const graph = runSmithers(["graph", WF_PATH, "--root", "."], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(graph.exitCode).toBe(0);
    expect(graph.json).toBeTruthy();
});

test("resume re-uses the root persisted on the run, not the resume context", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, WF_PATH);
    const customRoot = repo.path("custom-root");
    mkdirSync(customRoot, { recursive: true });

    const first = runSmithers(["up", WF_PATH, "--root", customRoot, "--run-id", "resume-root"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(first.exitCode).toBe(0);
    expect(first.json.status).toBe("finished");

    const before = runSmithers(["inspect", "resume-root"], { cwd: repo.dir, format: "json" });
    expect(before.json.config?.rootDir).toBe(customRoot);

    // Resume WITHOUT --root: the engine rewrites configJson with the launch root,
    // so the resumed run must recover the original custom root from the persisted
    // config rather than re-deriving it (which would snap back to the repo root).
    const resumed = runSmithers(["up", WF_PATH, "--resume", "--run-id", "resume-root", "--force"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(resumed.exitCode).toBe(0);

    const after = runSmithers(["inspect", "resume-root"], { cwd: repo.dir, format: "json" });
    expect(after.json.config?.rootDir).toBe(customRoot);
});
