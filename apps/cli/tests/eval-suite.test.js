import { describe, expect, test } from "bun:test";
import {
    assertEvalRunIdsAvailable,
    buildEvalPlan,
    evaluateEvalCaseResult,
    evalRunId,
    loadEvalCases,
    renderEvalPlan,
} from "../src/eval-suite.js";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

describe("eval suite helpers", () => {
    test("loads JSONL cases and builds stable run IDs", () => {
        const repo = createTempRepo();
        repo.write("evals/smoke.jsonl", [
            '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished"}}',
            '{"name":"Beta Case","input":{"prompt":"B"},"annotations":{"area":"docs"}}',
            "",
        ].join("\n"));

        const loaded = loadEvalCases(repo.dir, "evals/smoke.jsonl");
        const plan = buildEvalPlan({
            suiteId: "Release Smoke",
            runLabel: "ci-123",
            workflowPath: "workflow.tsx",
            casesPath: "evals/smoke.jsonl",
            loadedCases: loaded,
        });

        expect(plan.suiteId).toBe("release-smoke");
        expect(plan.runLabel).toBe("ci-123");
        expect(plan.plannedCases).toBe(2);
        expect(plan.cases[0].runId).toBe("eval-release-smoke-ci-123-alpha");
        expect(plan.cases[1].id).toBe("beta-case");
        expect(renderEvalPlan(plan)).toContain("Dry run only");
    });

    test("caps long eval run IDs", () => {
        const id = evalRunId("suite-with-a-very-long-name-that-keeps-going", "case-with-a-very-long-name-that-keeps-going");
        expect(id.length).toBeLessThanOrEqual(64);
        expect(id.startsWith("eval-")).toBe(true);
    });

    test("rejects ambiguous eval case files before planning", () => {
        const repo = createTempRepo();
        repo.write("evals/dupes.jsonl", [
            '{"id":"Alpha Case","input":{}}',
            '{"id":"alpha-case","input":{}}',
        ].join("\n"));
        expect(() => loadEvalCases(repo.dir, "evals/dupes.jsonl")).toThrow("Duplicate eval case ID after normalization: alpha-case");

        repo.write("evals/unknown-expected.jsonl", '{"id":"alpha","expected":{"outputsContains":{}}}\n');
        expect(() => loadEvalCases(repo.dir, "evals/unknown-expected.jsonl")).toThrow("unsupported assertion keys");
    });

    test("evaluates status, exact output, and partial output assertions", () => {
        const testCase = {
            id: "checks",
            name: "checks",
            input: {},
            annotations: {},
            expected: {
                status: "finished",
                output: [{ summary: "ok", nested: { score: 1 } }],
                outputContains: [{ nested: { score: 1 } }],
            },
            metadata: {},
        };
        const result = evaluateEvalCaseResult(testCase, {
            status: "finished",
            output: [{ nested: { score: 1 }, summary: "ok" }],
        });

        expect(result.passed).toBe(true);
        expect(result.assertions.map((assertion) => assertion.name)).toEqual([
            "status",
            "output",
            "outputContains",
        ]);
    });

    test("matches partial output array entries outside the prefix", () => {
        const testCase = {
            id: "array-contains",
            name: "array-contains",
            input: {},
            annotations: {},
            expected: {
                status: "finished",
                outputContains: {
                    result: [
                        { prompt: "B" },
                        { prompt: "C" },
                    ],
                },
            },
            metadata: {},
        };
        const result = evaluateEvalCaseResult(testCase, {
            status: "finished",
            output: {
                result: [
                    { prompt: "A", summary: "first" },
                    { prompt: "B", summary: "second" },
                    { prompt: "C", summary: "third" },
                ],
            },
        });

        expect(result.passed).toBe(true);
        expect(result.assertions.find((assertion) => assertion.name === "outputContains")?.passed).toBe(true);
    });

    test("supports continued status and structured error matching", () => {
        const testCase = {
            id: "error",
            name: "error",
            input: {},
            annotations: {},
            expected: {
                status: "continued",
                errorContains: "durable handoff",
            },
            metadata: {},
        };
        const result = evaluateEvalCaseResult(testCase, {
            status: "continued",
            error: { message: "continued via durable handoff", code: "CONTINUED" },
        });

        expect(result.passed).toBe(true);
        expect(result.assertions.map((assertion) => assertion.name)).toEqual([
            "status",
            "errorContains",
        ]);
    });

    test("detects existing run IDs before execution", async () => {
        let checked = 0;
        await assertEvalRunIdsAvailable({
            async getRun(runId) {
                checked += 1;
                return runId === "eval-smoke-alpha" ? { runId } : null;
            },
        }, [
            { runId: "eval-smoke-alpha" },
            { runId: "eval-smoke-beta" },
        ]).then(() => {
            throw new Error("expected duplicate run ID rejection");
        }).catch((err) => {
            expect(err.message).toContain("Eval run ID already exists");
        });
        expect(checked).toBe(2);
    });
});

describe("smithers eval command", () => {
    test("prints a dry-run plan", () => {
        const repo = createTempRepo();
        writeTestWorkflow(repo);
        repo.write("evals/smoke.jsonl", '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished"}}\n');

        const result = runSmithers([
            "eval",
            "workflow.tsx",
            "--cases",
            "evals/smoke.jsonl",
            "--suite",
            "smoke",
            "--run-label",
            "ci",
            "--dry-run",
        ], { cwd: repo.dir, format: null });

        if (result.exitCode !== 0) {
            throw new Error(`smithers eval exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        expect(result.stdout).toContain("Eval suite: smoke");
        expect(result.stdout).toContain("eval-smoke-ci-alpha");
        expect(result.stdout).toContain("Dry run only");
    });

    test("runs cases, checks outputs, and writes a report", () => {
        const repo = createTempRepo();
        writeTestWorkflow(repo);
        repo.write("evals/smoke.jsonl", [
            '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished","outputContains":{"result":[{"prompt":"A"}]}}}',
            '{"id":"beta","input":{"prompt":"B"},"expected":{"status":"finished","outputContains":{"result":[{"summary":"fixture workflow ran"}]}}}',
            "",
        ].join("\n"));

        const result = runSmithers([
            "eval",
            "workflow.tsx",
            "--cases",
            "evals/smoke.jsonl",
            "--suite",
            "smoke",
            "--run-label",
            "ci",
            "--report",
            "artifacts/smoke-report.json",
            "--force",
        ], { cwd: repo.dir, format: "json" });

        if (result.exitCode !== 0) {
            throw new Error(`smithers eval exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        expect(result.json?.eval.summary).toMatchObject({
            total: 2,
            passed: 2,
            failed: 0,
        });
        expect(result.json?.eval.results[0]).toMatchObject({
            caseId: "alpha",
            runId: "eval-smoke-ci-alpha",
            passed: true,
        });
        expect(repo.exists("artifacts/smoke-report.json")).toBe(true);
        const report = JSON.parse(repo.read("artifacts/smoke-report.json"));
        expect(report.summary.total).toBe(2);
        expect(report.results[0].assertions.map((assertion) => assertion.name)).toContain("outputContains");
        expect(report.results[0].output.result[0].prompt).toBe("A");

        const rerun = runSmithers([
            "eval",
            "workflow.tsx",
            "--cases",
            "evals/smoke.jsonl",
            "--suite",
            "smoke",
            "--run-label",
            "ci",
            "--report",
            "artifacts/smoke-report.json",
            "--force",
        ], { cwd: repo.dir, format: "json" });

        expect(rerun.exitCode).toBe(4);
        expect(rerun.json?.code).toBe("EVAL_RUN_ID_EXISTS");
    }, 20_000);
});
