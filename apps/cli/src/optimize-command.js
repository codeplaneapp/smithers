import { basename, dirname, extname, join, resolve } from "node:path";
import crypto from "node:crypto";
import { Effect } from "effect";
import { z } from "incur";
import { OPTIMIZATION_ARTIFACT_ENV, renderFrame, resolveSchema, runWorkflow } from "@smithers-orchestrator/engine";
import { loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { SmithersCtx } from "@smithers-orchestrator/driver";
import { SmithersError } from "@smithers-orchestrator/errors";
import {
    assertEvalRunIdsAvailable,
    buildEvalPlan,
    buildEvalReport,
    evaluateEvalCaseResult,
    loadEvalCases,
    writeEvalReport,
} from "./eval-suite.js";
import {
    OPTIMIZER_PROVIDER_IDS,
    buildProviderGepaPatches,
    discoverOptimizablePromptTasks,
    renderOptimizationReport,
    resolveOptimizerProviderModel,
    scoreOptimizationReport,
    writeCandidateOptimizationArtifact,
    writeOptimizationArtifact,
} from "./optimize-suite.js";

export const optimizeOptions = z.object({
    cases: z.string().describe("JSON or JSONL eval case file"),
    suite: z.string().optional().describe("Stable suite ID used in run IDs and report paths"),
    provider: z.enum(OPTIMIZER_PROVIDER_IDS).default("cerebras").describe("GEPA patch generator provider"),
    model: z.string().optional().describe("Optimizer model for provider-backed GEPA"),
    artifact: z.string().optional().describe("Write the optimized prompt artifact to this path"),
    reportDir: z.string().optional().describe("Directory for baseline and optimized eval reports"),
    minImprovement: z.number().default(0.000001).describe("Minimum required absolute score improvement"),
    maxCases: z.number().int().min(1).optional().describe("Run only the first N cases"),
    concurrency: z.number().int().min(1).max(16).default(1).describe("Number of eval cases to run at once"),
    maxConcurrency: z.number().int().min(1).optional().describe("Per-workflow max task concurrency"),
    root: z.string().optional().describe("Tool sandbox root directory"),
    log: z.boolean().default(true).describe("Enable NDJSON event log file output"),
    logDir: z.string().optional().describe("NDJSON event logs directory"),
    allowNetwork: z.boolean().default(false).describe("Allow bash tool network requests"),
    maxOutputBytes: z.number().int().min(1).optional().describe("Max bytes a single tool call can return"),
    toolTimeoutMs: z.number().int().min(1).optional().describe("Max wall-clock time per tool call in ms"),
});

/**
 * @template T
 * @param {string | null | undefined} artifactPath
 * @param {() => Promise<T>} execute
 * @returns {Promise<T>}
 */
export async function withOptimizationArtifactEnv(artifactPath, execute) {
    const previous = process.env[OPTIMIZATION_ARTIFACT_ENV];
    if (artifactPath) {
        process.env[OPTIMIZATION_ARTIFACT_ENV] = artifactPath;
    }
    else {
        delete process.env[OPTIMIZATION_ARTIFACT_ENV];
    }
    try {
        return await execute();
    }
    finally {
        if (previous === undefined) {
            delete process.env[OPTIMIZATION_ARTIFACT_ENV];
        }
        else {
            process.env[OPTIMIZATION_ARTIFACT_ENV] = previous;
        }
    }
}

/**
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runWithLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }));
    return results;
}

/**
 * @param {{
 *   workflow: import("@smithers-orchestrator/components").SmithersWorkflow<any>;
 *   workflowPath: string;
 *   plan: ReturnType<typeof buildEvalPlan>;
 *   options: Record<string, any>;
 *   setupAbortSignal: () => AbortController;
 *   reportPath?: string;
 *   optimizationArtifact?: string | null;
 * }} input
 */
async function executeEvalPlan(input) {
    ensureSmithersTables(input.workflow.db);
    const schema = resolveSchema(input.workflow.db);
    const resolvedWorkflowPath = resolve(process.cwd(), input.workflowPath);
    const rootDir = input.options.root ? resolve(process.cwd(), input.options.root) : dirname(resolvedWorkflowPath);
    const logDir = input.options.log ? input.options.logDir : null;
    const abort = input.setupAbortSignal();
    const startedAtMs = Date.now();
    const results = await withOptimizationArtifactEnv(input.optimizationArtifact, () => runWithLimit(input.plan.cases, input.options.concurrency ?? 1, async (testCase) => {
        const caseStartedAtMs = Date.now();
        process.stderr.write(`[eval:${input.plan.suiteId}] ${testCase.id} -> ${testCase.runId}\n`);
        try {
            const result = await Effect.runPromise(runWorkflow(input.workflow, {
                input: testCase.input,
                runId: testCase.runId,
                workflowPath: resolvedWorkflowPath,
                maxConcurrency: input.options.maxConcurrency,
                rootDir,
                logDir,
                allowNetwork: input.options.allowNetwork,
                maxOutputBytes: input.options.maxOutputBytes,
                toolTimeoutMs: input.options.toolTimeoutMs,
                annotations: {
                    suiteId: input.plan.suiteId,
                    caseId: testCase.id,
                    ...testCase.annotations,
                },
                signal: abort.signal,
            }));
            const output = await loadOutputs(input.workflow.db, schema, testCase.runId);
            const durationMs = Date.now() - caseStartedAtMs;
            const evaluation = evaluateEvalCaseResult(testCase, {
                ...result,
                output,
            });
            return {
                caseId: testCase.id,
                runId: testCase.runId,
                expectedStatus: testCase.expected.status,
                status: result.status,
                passed: evaluation.passed,
                assertions: evaluation.assertions,
                durationMs,
                input: testCase.input,
                ...(input.options.includeOutput === false ? {} : { output }),
                metadata: testCase.metadata,
            };
        }
        catch (err) {
            const errorMessage = err?.message ?? String(err);
            const durationMs = Date.now() - caseStartedAtMs;
            const evaluation = evaluateEvalCaseResult(testCase, {
                status: "error",
                error: err,
            });
            return {
                caseId: testCase.id,
                runId: testCase.runId,
                expectedStatus: testCase.expected.status,
                status: "error",
                passed: evaluation.passed,
                assertions: evaluation.assertions,
                durationMs,
                input: testCase.input,
                error: errorMessage,
                metadata: testCase.metadata,
            };
        }
    }));
    const finishedAtMs = Date.now();
    const report = buildEvalReport({
        plan: input.plan,
        results,
        startedAtMs,
        finishedAtMs,
    });
    const reportPath = writeEvalReport(process.cwd(), report, {
        path: input.reportPath,
        force: true,
    });
    return { ...report, reportPath };
}

/**
 * @param {{
 *   workflow: import("@smithers-orchestrator/components").SmithersWorkflow<any>;
 *   workflowPath: string;
 *   cases: Array<Record<string, any>>;
 * }} input
 */
async function discoverOptimizablePromptTasksForCases(input) {
    const resolvedWorkflowPath = resolve(process.cwd(), input.workflowPath);
    /** @type {Map<string, ReturnType<typeof discoverOptimizablePromptTasks>[number]>} */
    const discovered = new Map();
    for (const testCase of input.cases) {
        const ctx = new SmithersCtx({
            runId: `optimize-discovery-${testCase.id ?? crypto.randomUUID()}`,
            iteration: 0,
            input: testCase?.input ?? {},
            outputs: {},
            zodToKeyName: input.workflow.zodToKeyName,
        });
        const snap = await Effect.runPromise(renderFrame(input.workflow, ctx, {
            baseRootDir: dirname(resolvedWorkflowPath),
            workflowPath: resolvedWorkflowPath,
        }));
        for (const task of discoverOptimizablePromptTasks(snap.tasks)) {
            const existing = discovered.get(task.nodeId);
            if (!existing) {
                discovered.set(task.nodeId, {
                    ...task,
                    promptSamples: [{ caseId: testCase.id, prompt: task.prompt, promptHash: task.promptHash }],
                });
                continue;
            }
            const samples = Array.isArray(existing.promptSamples) ? existing.promptSamples : [];
            if (!samples.some((sample) => sample.promptHash === task.promptHash)) {
                discovered.set(task.nodeId, {
                    ...existing,
                    promptSamples: [...samples, { caseId: testCase.id, prompt: task.prompt, promptHash: task.promptHash }],
                });
            }
        }
    }
    return [...discovered.values()];
}

/**
 * @param {any} c
 * @param {{
 *   defaultEvalRunLabel: () => string;
 *   formatRequestedJsonOutput: () => boolean;
 *   loadWorkflow: (path: string) => Promise<import("@smithers-orchestrator/components").SmithersWorkflow<any>>;
 *   resolveWorkflowPathForEval: (workflowInput: string) => string;
 *   setupAbortSignal: () => AbortController;
 *   setupSqliteCleanup: (workflow: import("@smithers-orchestrator/components").SmithersWorkflow<any>) => void;
 *   setCommandExitOverride: (exitCode: number) => void;
 * }} deps
 */
export async function runOptimizeCommand(c, deps) {
    const fail = (opts) => {
        deps.setCommandExitOverride(opts.exitCode ?? 1);
        return c.error(opts);
    };
    try {
        const workflowPath = deps.resolveWorkflowPathForEval(c.args.workflow);
        const loadedCases = loadEvalCases(process.cwd(), c.options.cases, {
            maxCases: c.options.maxCases,
        });
        const runLabel = deps.defaultEvalRunLabel();
        const suiteBase = c.options.suite ?? `${basename(c.options.cases, extname(c.options.cases))}-opt`;
        const baselinePlan = buildEvalPlan({
            suiteId: `${suiteBase}-baseline`,
            runLabel,
            workflowPath,
            casesPath: c.options.cases,
            loadedCases,
        });
        const optimizedPlan = buildEvalPlan({
            suiteId: `${suiteBase}-optimized`,
            runLabel,
            workflowPath,
            casesPath: c.options.cases,
            loadedCases,
        });
        const workflow = await deps.loadWorkflow(workflowPath);
        ensureSmithersTables(workflow.db);
        const adapter = new SmithersDb(workflow.db);
        await assertEvalRunIdsAvailable(adapter, [...baselinePlan.cases, ...optimizedPlan.cases]);
        deps.setupSqliteCleanup(workflow);
        const reportDir = c.options.reportDir
            ? resolve(process.cwd(), c.options.reportDir)
            : resolve(process.cwd(), ".smithers", "optimizations", "reports");
        const promptTasks = await discoverOptimizablePromptTasksForCases({
            workflow,
            workflowPath,
            cases: loadedCases.cases,
        });
        if (promptTasks.length === 0) {
            throw new SmithersError("INVALID_INPUT", "No agent-backed prompt tasks were found to optimize.", {
                workflowPath,
            });
        }
        const baselineReport = await executeEvalPlan({
            workflow,
            workflowPath,
            plan: baselinePlan,
            setupAbortSignal: deps.setupAbortSignal,
            options: {
                ...c.options,
                includeOutput: true,
            },
            reportPath: join(reportDir, `${baselinePlan.suiteId}.json`),
        });
        const promptPatches = await buildProviderGepaPatches({
            provider: c.options.provider,
            model: c.options.model,
            promptTasks,
            cases: loadedCases.cases,
            baselineReport,
        });
        if (Object.keys(promptPatches).length === 0) {
            throw new SmithersError("INVALID_INPUT", "GEPA did not produce any prompt patches.", {
                provider: c.options.provider,
            });
        }
        const candidateArtifactPath = writeCandidateOptimizationArtifact(process.cwd(), promptPatches);
        const optimizedReport = await executeEvalPlan({
            workflow,
            workflowPath,
            plan: optimizedPlan,
            setupAbortSignal: deps.setupAbortSignal,
            options: {
                ...c.options,
                includeOutput: true,
            },
            reportPath: join(reportDir, `${optimizedPlan.suiteId}.json`),
            optimizationArtifact: candidateArtifactPath,
        });
        const baselineScore = scoreOptimizationReport(baselineReport);
        const optimizedScore = scoreOptimizationReport(optimizedReport);
        const improvement = optimizedScore.score - baselineScore.score;
        if (improvement < c.options.minImprovement) {
            return fail({
                code: "OPTIMIZATION_NO_IMPROVEMENT",
                message: `Optimized score did not improve enough: baseline=${baselineScore.score.toFixed(4)} optimized=${optimizedScore.score.toFixed(4)} requiredDelta=${c.options.minImprovement}`,
                exitCode: 1,
            });
        }
        const { artifact } = writeOptimizationArtifact({
            root: process.cwd(),
            workflowPath,
            requestedPath: c.options.artifact,
            provider: c.options.provider,
            model: resolveOptimizerProviderModel(c.options.provider, c.options.model) ?? "provider-default",
            promptTasks,
            promptPatches,
            baselineReport,
            candidateReport: optimizedReport,
        });
        if (c.format === "json" || c.format === "jsonl" || deps.formatRequestedJsonOutput()) {
            return c.ok({ optimization: artifact });
        }
        process.stdout.write(`${renderOptimizationReport(artifact)}\n`);
        return c.ok(undefined);
    }
    catch (err) {
        if (err instanceof SmithersError) {
            return fail({ code: err.code, message: err.message, exitCode: 4 });
        }
        return fail({ code: "OPTIMIZATION_FAILED", message: err?.message ?? String(err), exitCode: 1 });
    }
}
