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
