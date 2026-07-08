import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPTIMIZATION_ARTIFACT_ENV } from "@smithers-orchestrator/engine";
import { SmithersError } from "@smithers-orchestrator/errors";
import { optimizeOptions, runOptimizeCommand, withOptimizationArtifactEnv } from "../src/optimize-command.js";

const originalArtifactEnv = process.env[OPTIMIZATION_ARTIFACT_ENV];

afterEach(() => {
    if (originalArtifactEnv === undefined) {
        delete process.env[OPTIMIZATION_ARTIFACT_ENV];
    }
    else {
        process.env[OPTIMIZATION_ARTIFACT_ENV] = originalArtifactEnv;
    }
});

describe("withOptimizationArtifactEnv", () => {
    test("sets the env var during execute and removes it after when nothing was set before", async () => {
        delete process.env[OPTIMIZATION_ARTIFACT_ENV];
        let seen;
        const result = await withOptimizationArtifactEnv("/tmp/artifact.json", async () => {
            seen = process.env[OPTIMIZATION_ARTIFACT_ENV];
            return "done";
        });
        expect(result).toBe("done");
        expect(seen).toBe("/tmp/artifact.json");
        expect(process.env[OPTIMIZATION_ARTIFACT_ENV]).toBeUndefined();
    });

    test("restores a pre-existing value after execute", async () => {
        process.env[OPTIMIZATION_ARTIFACT_ENV] = "/pre/existing.json";
        let seen;
        await withOptimizationArtifactEnv("/tmp/candidate.json", async () => {
            seen = process.env[OPTIMIZATION_ARTIFACT_ENV];
        });
        expect(seen).toBe("/tmp/candidate.json");
        expect(process.env[OPTIMIZATION_ARTIFACT_ENV]).toBe("/pre/existing.json");
    });

    test("a null artifact path clears the env var during execute, then restores the previous value", async () => {
        process.env[OPTIMIZATION_ARTIFACT_ENV] = "/pre/existing.json";
        let seen = "unset-sentinel";
        await withOptimizationArtifactEnv(null, async () => {
            seen = process.env[OPTIMIZATION_ARTIFACT_ENV];
        });
        expect(seen).toBeUndefined();
        expect(process.env[OPTIMIZATION_ARTIFACT_ENV]).toBe("/pre/existing.json");
    });

    test("restores the env var even when execute throws", async () => {
        process.env[OPTIMIZATION_ARTIFACT_ENV] = "/pre/existing.json";
        await expect(withOptimizationArtifactEnv("/tmp/candidate.json", async () => {
            throw new Error("boom");
        })).rejects.toThrow("boom");
        expect(process.env[OPTIMIZATION_ARTIFACT_ENV]).toBe("/pre/existing.json");
    });
});

describe("optimizeOptions bounds", () => {
    const base = { cases: "evals/cases.json" };

    test("defaults provider/minImprovement/concurrency/log/allowNetwork", () => {
        const parsed = optimizeOptions.parse(base);
        expect(parsed.provider).toBe("cerebras");
        expect(parsed.minImprovement).toBeCloseTo(0.000001);
        expect(parsed.concurrency).toBe(1);
        expect(parsed.log).toBe(true);
        expect(parsed.allowNetwork).toBe(false);
    });

    test("accepts the concurrency boundaries 1 and 16 and rejects 0 and 17", () => {
        expect(optimizeOptions.parse({ ...base, concurrency: 1 }).concurrency).toBe(1);
        expect(optimizeOptions.parse({ ...base, concurrency: 16 }).concurrency).toBe(16);
        expect(() => optimizeOptions.parse({ ...base, concurrency: 0 })).toThrow();
        expect(() => optimizeOptions.parse({ ...base, concurrency: 17 })).toThrow();
    });

    test("rejects non-positive or fractional maxCases and non-positive tool limits", () => {
        expect(() => optimizeOptions.parse({ ...base, maxCases: 0 })).toThrow();
        expect(() => optimizeOptions.parse({ ...base, maxCases: 1.5 })).toThrow();
        expect(() => optimizeOptions.parse({ ...base, maxOutputBytes: 0 })).toThrow();
        expect(() => optimizeOptions.parse({ ...base, toolTimeoutMs: 0 })).toThrow();
        expect(optimizeOptions.parse({ ...base, maxCases: 1 }).maxCases).toBe(1);
    });

    test("rejects an unknown provider", () => {
        expect(() => optimizeOptions.parse({ ...base, provider: "not-a-provider" })).toThrow();
    });
});

describe("runOptimizeCommand failure mapping", () => {
    function makeC(options = {}) {
        const errors = [];
        return {
            errors,
            args: { workflow: "workflow.tsx" },
            options: { provider: "cerebras", minImprovement: 0.000001, concurrency: 1, log: false, allowNetwork: false, ...options },
            format: "json",
            error: (opts) => {
                errors.push(opts);
                return opts;
            },
            ok: (value) => ({ ok: value }),
        };
    }

    function makeDeps(overrides = {}) {
        const exitCodes = [];
        return {
            exitCodes,
            defaultEvalRunLabel: () => "unit",
            formatRequestedJsonOutput: () => true,
            loadWorkflow: async () => {
                throw new Error("loadWorkflow should not be reached");
            },
            resolveWorkflowPathForEval: (workflowInput) => workflowInput,
            setupAbortSignal: () => new AbortController(),
            setupSqliteCleanup: () => {},
            setCommandExitOverride: (code) => exitCodes.push(code),
            ...overrides,
        };
    }

    test("a SmithersError keeps its code and exits 4", async () => {
        const c = makeC({ cases: "evals/cases.json" });
        const deps = makeDeps({
            resolveWorkflowPathForEval: () => {
                throw new SmithersError("INVALID_INPUT", "bad workflow path");
            },
        });
        await runOptimizeCommand(c, deps);
        expect(c.errors).toHaveLength(1);
        expect(c.errors[0]).toMatchObject({ code: "INVALID_INPUT", exitCode: 4 });
        expect(c.errors[0].message).toContain("bad workflow path");
        expect(deps.exitCodes).toEqual([4]);
    });

    test("a generic error maps to OPTIMIZATION_FAILED and exits 1", async () => {
        const c = makeC({ cases: "evals/cases.json" });
        const deps = makeDeps({
            resolveWorkflowPathForEval: () => {
                throw new Error("disk exploded");
            },
        });
        await runOptimizeCommand(c, deps);
        expect(c.errors).toEqual([{ code: "OPTIMIZATION_FAILED", message: "disk exploded", exitCode: 1 }]);
        expect(deps.exitCodes).toEqual([1]);
    });

    test("a missing cases file surfaces the real loadEvalCases INVALID_INPUT (exit 4)", async () => {
        const missing = join(mkdtempSync(join(tmpdir(), "smithers-optimize-unit-")), "nope.json");
        const c = makeC({ cases: missing });
        const deps = makeDeps();
        await runOptimizeCommand(c, deps);
        expect(deps.exitCodes).toEqual([4]);
        expect(c.errors[0].code).toBe("INVALID_INPUT");
        expect(c.errors[0].message).toContain("Eval case file not found");
    });

    test("an empty cases file (zero cases) is rejected before any workflow is loaded", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-optimize-unit-"));
        const casesPath = join(dir, "empty.json");
        writeFileSync(casesPath, "[]\n", "utf8");
        const c = makeC({ cases: casesPath });
        const deps = makeDeps();
        await runOptimizeCommand(c, deps);
        expect(deps.exitCodes).toEqual([4]);
        expect(c.errors[0].code).toBe("INVALID_INPUT");
        expect(c.errors[0].message).toContain("at least one case");
    });

    test("a workflow that fails to load keeps its SmithersError code (exit 4)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "smithers-optimize-unit-"));
        const casesPath = join(dir, "one.json");
        writeFileSync(casesPath, JSON.stringify([{ id: "alpha", input: {}, expected: { status: "finished" } }]), "utf8");
        const c = makeC({ cases: casesPath });
        const deps = makeDeps({
            loadWorkflow: async () => {
                throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "workflow.tsx must export default");
            },
        });
        await runOptimizeCommand(c, deps);
        expect(deps.exitCodes).toEqual([4]);
        expect(c.errors).toHaveLength(1);
        expect(c.errors[0]).toMatchObject({ code: "WORKFLOW_MISSING_DEFAULT", exitCode: 4 });
        expect(c.errors[0].message).toContain("must export default");
    });
});
