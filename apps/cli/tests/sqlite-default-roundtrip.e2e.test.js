import { expect, test } from "bun:test";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

test("default sqlite init/run/read round-trip needs no migration prompt", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/default-roundtrip.tsx");

    const run = runSmithers(["workflow", "run", "default-roundtrip", "--run-id", "sqlite-default-roundtrip"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
    expect(run.json.status).toBe("finished");

    const ps = runSmithers(["ps"], { cwd: repo.dir, format: "json", timeoutMs: 120_000 });
    expect(ps.exitCode).toBe(0);
    expect(ps.stderr).not.toContain("SMITHERS_MIGRATION_REQUIRED");
    expect(JSON.stringify(ps.json)).toContain("sqlite-default-roundtrip");

    const inspect = runSmithers(["inspect", "sqlite-default-roundtrip"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json.run.id).toBe("sqlite-default-roundtrip");

    const output = runSmithers(["output", "sqlite-default-roundtrip", "write-result"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 120_000,
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("fixture workflow ran");
});
