// @ts-nocheck
/**
 * <PlaywrightTestAgent> - Plan, generate, run, and heal Playwright E2E tests.
 *
 * Pattern: product brief -> test plan -> generated tests -> run/heal loop -> report.
 * Use cases: E2E test creation, selector repair, smoke-suite bootstrapping,
 * regression coverage for user stories.
 *
 * Smithers implementation: a Sequence handles the planner and generator, then a
 * bounded Loop persists every test run and repair attempt so failed traces and
 * healed tests are inspectable after resume or replay.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import PlanPrompt from "./prompts/playwright-test-agent/plan.mdx";
import GeneratePrompt from "./prompts/playwright-test-agent/generate.mdx";
import RunPrompt from "./prompts/playwright-test-agent/run.mdx";
import HealPrompt from "./prompts/playwright-test-agent/heal.mdx";
import ReportPrompt from "./prompts/playwright-test-agent/report.mdx";

const testPlanSchema = z.object({
    appUrl: z.string(),
    flows: z.array(z.object({
        name: z.string(),
        goal: z.string(),
        steps: z.array(z.string()),
        assertions: z.array(z.string()),
        risk: z.enum(["low", "medium", "high"]),
    })),
    assumptions: z.array(z.string()),
});

const generatedTestsSchema = z.object({
    files: z.array(z.object({
        path: z.string(),
        summary: z.string(),
        flowNames: z.array(z.string()),
    })),
    commands: z.array(z.string()),
    notes: z.string(),
});

const testRunSchema = z.object({
    passed: z.boolean(),
    command: z.string(),
    total: z.number(),
    failed: z.number(),
    failures: z.array(z.object({
        file: z.string(),
        message: z.string(),
        tracePath: z.string().optional(),
        screenshotPath: z.string().optional(),
    })),
    artifacts: z.array(z.string()),
});

const finalReportSchema = z.object({
    status: z.enum(["passed", "needs-human-review", "failed"]),
    coverageSummary: z.string(),
    iterations: z.number(),
    artifacts: z.array(z.string()),
    nextActions: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
    testPlan: testPlanSchema,
    generatedTests: generatedTestsSchema,
    testRun: testRunSchema,
    finalReport: finalReportSchema,
});

const plannerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, bash, grep },
    instructions: `You are an E2E test planner. Explore the product brief, existing tests,
and app routes. Produce a focused Playwright plan with flows, steps, assertions,
and risk. Prefer user-visible behavior over implementation details.`,
});

const generatorAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, write, bash, grep },
    instructions: `You are a Playwright test generator. Write tests under tests/generated
or the requested test directory. Keep selectors stable, set up fixtures explicitly,
and do not weaken assertions to make tests pass.`,
});

const runnerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { bash, read },
    instructions: `You are a Playwright runner. Execute the requested command, collect
failure messages, traces, screenshots, and summarize pass/fail status precisely.`,
});

const healerAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read, write, bash, grep },
    instructions: `You are a Playwright test healer. Repair broken selectors, waits,
fixtures, and setup. Preserve the user-story assertions unless you explicitly
explain why an assertion was invalid.`,
});

const reporterAgent = new Agent({
    model: anthropic("claude-sonnet-4-6"),
    tools: { read },
    instructions: `You are an E2E QA reporter. Summarize generated coverage, remaining
failures, artifacts, and concrete follow-up actions.`,
});

export default smithers((ctx) => {
    const runs = ctx.outputs.testRun ?? [];
    const generatedAttempts = ctx.outputs.generatedTests ?? [];
    const latestRun = runs[runs.length - 1];
    const latestGenerated = generatedAttempts[generatedAttempts.length - 1];
    const passed = latestRun?.passed === true;

    return (
        <Workflow name="playwright-test-agent">
            <Sequence>
                <Task id="plan-tests" output={outputs.testPlan} agent={plannerAgent}>
                    <PlanPrompt
                        appUrl={ctx.input.appUrl ?? "http://localhost:3000"}
                        productBrief={ctx.input.productBrief ?? ctx.input.story ?? ""}
                        seedTest={ctx.input.seedTest ?? null}
                        existingTestGlob={ctx.input.existingTestGlob ?? "tests/**/*.spec.{ts,tsx}"}
                    />
                </Task>

                <Task id="generate-tests" output={outputs.generatedTests} agent={generatorAgent}>
                    <GeneratePrompt
                        plan={ctx.outputMaybe("testPlan", { nodeId: "plan-tests" })}
                        testDirectory={ctx.input.testDirectory ?? "tests/generated"}
                        appUrl={ctx.input.appUrl ?? "http://localhost:3000"}
                    />
                </Task>

                <Loop
                    until={passed}
                    maxIterations={ctx.input.maxIterations ?? 4}
                    onMaxReached="return-last"
                >
                    <Sequence>
                        <Task id="run-tests" output={outputs.testRun} agent={runnerAgent}>
                            <RunPrompt
                                generatedTests={latestGenerated}
                                command={ctx.input.testCommand ?? "npx playwright test tests/generated --trace retain-on-failure"}
                                appUrl={ctx.input.appUrl ?? "http://localhost:3000"}
                            />
                        </Task>

                        <Task id="heal-tests" output={outputs.generatedTests} agent={healerAgent} skipIf={passed}>
                            <HealPrompt
                                generatedTests={latestGenerated}
                                latestRun={latestRun}
                                productBrief={ctx.input.productBrief ?? ctx.input.story ?? ""}
                                assertionPolicy={ctx.input.assertionPolicy ?? "Do not remove or weaken business-critical assertions."}
                            />
                        </Task>
                    </Sequence>
                </Loop>

                <Task id="report" output={outputs.finalReport} agent={reporterAgent}>
                    <ReportPrompt
                        plan={ctx.outputMaybe("testPlan", { nodeId: "plan-tests" })}
                        generatedAttempts={generatedAttempts}
                        runs={runs}
                        passed={passed}
                    />
                </Task>
            </Sequence>
        </Workflow>
    );
});
