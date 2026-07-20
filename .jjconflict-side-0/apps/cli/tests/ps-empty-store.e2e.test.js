import { expect, test } from "bun:test";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

test("ps in a never-initialized directory returns an empty run list with exit 0", () => {
    // A fresh temp repo has no smithers.db / store at all.
    const repo = createTempRepo();

    const ps = runSmithers(["ps"], { cwd: repo.dir, format: "json", timeoutMs: 120_000 });

    expect(ps.exitCode).toBe(0);
    expect(ps.stderr).not.toContain("PS_FAILED");
    expect(ps.json).toBeDefined();
    expect(ps.json.runs).toEqual([]);
});

test("ps still lists runs after a real init + run", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/ps-after-run.tsx");

    const run = runSmithers(["workflow", "run", "ps-after-run", "--run-id", "ps-empty-store-roundtrip"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.json.status).toBe("finished");

    const ps = runSmithers(["ps"], { cwd: repo.dir, format: "json", timeoutMs: 120_000 });
    expect(ps.exitCode).toBe(0);
    expect(JSON.stringify(ps.json)).toContain("ps-empty-store-roundtrip");
});
