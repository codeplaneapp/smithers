import { describe, expect, test } from "bun:test";
import {
    buildHeuristicGepaPatches,
    discoverOptimizablePromptTasks,
    scoreOptimizationReport,
} from "../src/optimize-suite.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

function writeOptimizableWorkflow(repo) {
    return repo.write("workflow.tsx", [
        "/** @jsxImportSource smithers-orchestrator */",
        'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
        'import { z } from "zod";',
        "",
        "const { smithers, outputs } = createSmithers({",
        "  result: z.object({",
        "    optimized: z.boolean(),",
        "    prompt: z.string(),",
        "  }),",
        "});",
        "",
        "const promptSensitiveAgent = {",
        '  id: "prompt-sensitive-agent",',
        '  model: "fixture-model",',
        "  generate: async ({ prompt }) => {",
        '    const optimized = prompt.includes("OPTIMIZED_TOKEN");',
        "    const output = { optimized, prompt };",
        "    return { text: JSON.stringify(output), output };",
        "  },",
        "};",
        "",
        "export default smithers((ctx) => (",
        '  <Workflow name="optimizable-workflow">',
        '    <Task id="answer" output={outputs.result} agent={promptSensitiveAgent}>',
        "      {`Answer the request: ${ctx.input.prompt}`}",
        "    </Task>",
        "  </Workflow>",
        "));",
        "",
    ].join("\n"));
}

describe("optimize suite helpers", () => {
    test("scores reports and creates GEPA prompt patches from failed-case hints", () => {
        const tasks = discoverOptimizablePromptTasks([
            { nodeId: "answer", agent: { id: "agent" }, prompt: "Base prompt" },
            { nodeId: "static", prompt: "ignored" },
        ]);
        expect(tasks.map((task) => task.nodeId)).toEqual(["answer"]);

        const baselineReport = {
            results: [
                {
                    caseId: "alpha",
                    passed: false,
                    assertions: [{ passed: true }, { passed: false }],
                },
            ],
        };
        expect(scoreOptimizationReport(baselineReport).score).toBe(0.1);

        const patches = buildHeuristicGepaPatches(tasks, [
            {
                id: "alpha",
                metadata: {
                    optimizationHints: {
                        answer: "Include OPTIMIZED_TOKEN.",
                    },
                },
            },
        ], baselineReport);
        expect(patches.answer.prompt).toContain("Base prompt");
        expect(patches.answer.prompt).toContain("OPTIMIZED_TOKEN");
    });
});

describe("smithers optimize command", () => {
    test("proves a GEPA prompt artifact improves eval results and can be reused", () => {
        const repo = createTempRepo();
        writeOptimizableWorkflow(repo);
        repo.write("evals/opt.jsonl", JSON.stringify({
            id: "alpha",
            input: { prompt: "make the answer good" },
            expected: {
                status: "finished",
                outputContains: {
                    result: [{ optimized: true }],
                },
            },
            metadata: {
                optimizationHints: {
                    answer: "Include the exact token OPTIMIZED_TOKEN so the agent selects the optimized behavior.",
                },
            },
        }) + "\n");

        const result = runSmithers([
            "optimize",
            "workflow.tsx",
            "--cases",
            "evals/opt.jsonl",
            "--suite",
            "opt-proof",
            "--provider",
            "heuristic",
            "--artifact",
            "artifacts/optimized.json",
            "--report-dir",
            "artifacts/reports",
        ], { cwd: repo.dir, format: "json", timeoutMs: 60_000 });

        if (result.exitCode !== 0) {
            throw new Error(`smithers optimize exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        const optimization = result.json?.optimization;
        expect(optimization.baseline.passed).toBe(0);
        expect(optimization.optimized.passed).toBe(1);
        expect(optimization.improvement.absolute).toBeGreaterThan(0);
        expect(repo.exists("artifacts/optimized.json")).toBe(true);
        const artifact = JSON.parse(repo.read("artifacts/optimized.json"));
        expect(artifact.optimizer.axCompatible).toBe(true);
        expect(artifact.optimizer.axArtifactKind).toBe("AxGEPA.optimizedProgram");
        expect(artifact.promptPatches.answer.prompt).toContain("OPTIMIZED_TOKEN");

        const baselineReport = JSON.parse(repo.read("artifacts/reports/opt-proof-baseline.json"));
        const optimizedReport = JSON.parse(repo.read("artifacts/reports/opt-proof-optimized.json"));
        expect(baselineReport.summary.failed).toBe(1);
        expect(optimizedReport.summary.passed).toBe(1);

        const verification = runSmithers([
            "eval",
            "workflow.tsx",
            "--cases",
            "evals/opt.jsonl",
            "--suite",
            "opt-artifact",
            "--run-label",
            "verify",
            "--optimization",
            "artifacts/optimized.json",
            "--report",
            "artifacts/reuse-report.json",
            "--force",
        ], { cwd: repo.dir, format: "json", timeoutMs: 60_000 });

        if (verification.exitCode !== 0) {
            throw new Error(`smithers eval --optimization exited ${verification.exitCode}\nstdout:\n${verification.stdout}\nstderr:\n${verification.stderr}`);
        }
        expect(verification.json?.eval.summary).toMatchObject({
            total: 1,
            passed: 1,
            failed: 0,
        });
    }, 120_000);
});
