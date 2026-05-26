import { describe, expect, test } from "bun:test";
import {
    OPTIMIZER_PROVIDER_IDS,
    buildProviderGepaPatches,
    buildHeuristicGepaPatches,
    discoverOptimizablePromptTasks,
    getOptimizerProviderConfig,
    resolveOptimizerProviderModel,
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

function writeConditionalOptimizableWorkflow(repo) {
    return repo.write("conditional-workflow.tsx", [
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
        '  <Workflow name="conditional-optimizable-workflow">',
        '    {ctx.input.kind === "secondary" ? (',
        '      <Task id="secondary" output={outputs.result} agent={promptSensitiveAgent}>',
        "        {`Secondary answer for ${ctx.input.prompt}`}",
        "      </Task>",
        "    ) : (",
        '      <Task id="primary" output={outputs.result} agent={promptSensitiveAgent}>',
        "        {`Primary answer with OPTIMIZED_TOKEN for ${ctx.input.prompt}`}",
        "      </Task>",
        "    )}",
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

    test("covers Smithers account and agent provider ids", () => {
        expect(OPTIMIZER_PROVIDER_IDS).toEqual(expect.arrayContaining([
            "claude-code",
            "codex",
            "antigravity",
            "gemini",
            "kimi",
            "anthropic-api",
            "openai-api",
            "gemini-api",
            "opencode",
            "pi",
            "amp",
            "forge",
        ]));
        expect(getOptimizerProviderConfig("claude-code")?.kind).toBe("anthropic");
        expect(getOptimizerProviderConfig("codex")?.kind).toBe("openai-compatible");
        expect(getOptimizerProviderConfig("antigravity")?.kind).toBe("gemini");
        expect(getOptimizerProviderConfig("kimi")?.kind).toBe("openai-compatible");
        expect(resolveOptimizerProviderModel("cerebras")).toBe("gpt-oss-120b");
        expect(resolveOptimizerProviderModel("openai-compatible", "custom-model")).toBe("custom-model");
    });

    test("builds provider optimizer calls for OpenAI-compatible, Anthropic, and Gemini providers", async () => {
        const promptTasks = [{ nodeId: "answer", prompt: "Base prompt", promptHash: "abc", label: null }];
        const cases = [{ id: "alpha", input: {}, expected: {}, metadata: {} }];
        const baselineReport = { results: [{ caseId: "alpha", passed: false, assertions: [] }] };
        const successfulPatch = JSON.stringify({
            patches: [{ nodeId: "answer", prompt: "Improved prompt", rationale: "Because the eval failed." }],
        });
        /** @type {Array<{ url: string; body: any; headers: Record<string, string> }>} */
        const calls = [];
        const fakeFetch = async (url, init) => {
            calls.push({
                url: String(url),
                body: JSON.parse(String(init?.body)),
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
            });
            if (String(url).includes(":generateContent")) {
                return new Response(JSON.stringify({
                    candidates: [{ content: { parts: [{ text: successfulPatch }] } }],
                }), { status: 200 });
            }
            if (String(url).endsWith("/messages")) {
                return new Response(JSON.stringify({
                    content: [{ type: "text", text: successfulPatch }],
                }), { status: 200 });
            }
            return new Response(JSON.stringify({
                choices: [{ message: { content: successfulPatch } }],
            }), { status: 200 });
        };

        const openaiPatches = await buildProviderGepaPatches({
            provider: "codex",
            promptTasks,
            cases,
            baselineReport,
        }, { fetch: fakeFetch, env: { OPENAI_API_KEY: "openai-key" } });
        expect(openaiPatches.answer.source).toBe("codex-gepa");
        expect(calls.at(-1).url).toBe("https://api.openai.com/v1/chat/completions");
        expect(calls.at(-1).body.model).toBe("gpt-5.3-codex");

        await buildProviderGepaPatches({
            provider: "claude-code",
            model: "claude-test",
            promptTasks,
            cases,
            baselineReport,
        }, { fetch: fakeFetch, env: { ANTHROPIC_API_KEY: "anthropic-key" } });
        expect(calls.at(-1).url).toBe("https://api.anthropic.com/v1/messages");
        expect(calls.at(-1).headers["x-api-key"]).toBe("anthropic-key");
        expect(calls.at(-1).body.model).toBe("claude-test");

        await buildProviderGepaPatches({
            provider: "antigravity",
            model: "gemini-test",
            promptTasks,
            cases,
            baselineReport,
        }, { fetch: fakeFetch, env: { GOOGLE_API_KEY: "google-key" } });
        expect(calls.at(-1).url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=google-key");
        expect(calls.at(-1).body.generationConfig.responseMimeType).toBe("application/json");
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
        expect(artifact.optimizer.name).toBe("smithers-gepa");
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

    test("discovers prompt tasks across all eval cases before optimizing", () => {
        const repo = createTempRepo();
        writeConditionalOptimizableWorkflow(repo);
        repo.write("evals/conditional.jsonl", [
            JSON.stringify({
                id: "primary-case",
                input: { kind: "primary", prompt: "already good" },
                expected: {
                    status: "finished",
                    outputContains: {
                        result: [{ optimized: true }],
                    },
                },
            }),
            JSON.stringify({
                id: "secondary-case",
                input: { kind: "secondary", prompt: "needs optimization" },
                expected: {
                    status: "finished",
                    outputContains: {
                        result: [{ optimized: true }],
                    },
                },
                metadata: {
                    optimizationHints: {
                        secondary: "Include the exact token OPTIMIZED_TOKEN so the secondary branch selects the optimized behavior.",
                    },
                },
            }),
        ].join("\n") + "\n");

        const result = runSmithers([
            "optimize",
            "conditional-workflow.tsx",
            "--cases",
            "evals/conditional.jsonl",
            "--suite",
            "conditional-opt",
            "--provider",
            "heuristic",
            "--artifact",
            "artifacts/conditional-optimized.json",
            "--report-dir",
            "artifacts/reports",
        ], { cwd: repo.dir, format: "json", timeoutMs: 60_000 });

        if (result.exitCode !== 0) {
            throw new Error(`smithers optimize conditional exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        }
        const artifact = JSON.parse(repo.read("artifacts/conditional-optimized.json"));
        expect(artifact.promptPatches.secondary.prompt).toContain("OPTIMIZED_TOKEN");
        expect(artifact.optimized.passed).toBe(2);
    }, 120_000);
});
