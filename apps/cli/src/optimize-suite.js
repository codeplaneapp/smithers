import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import crypto from "node:crypto";
import { SmithersError } from "@smithers-orchestrator/errors";

const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 */
function asString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {string} text
 */
function sha1(text) {
    return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * @param {Array<Record<string, any>>} tasks
 */
export function discoverOptimizablePromptTasks(tasks) {
    return tasks
        .filter((task) => task?.agent && typeof task.prompt === "string" && task.prompt.trim())
        .map((task) => ({
        nodeId: task.nodeId,
        prompt: task.prompt,
        promptHash: sha1(task.prompt),
        label: typeof task.label === "string" ? task.label : null,
    }));
}

/**
 * @param {Record<string, any>} report
 */
export function scoreOptimizationReport(report) {
    const results = Array.isArray(report.results) ? report.results : [];
    if (results.length === 0) {
        return {
            score: 0,
            passRate: 0,
            assertionPassRate: 0,
            passed: 0,
            total: 0,
        };
    }
    const passed = results.filter((result) => result?.passed).length;
    let assertionCount = 0;
    let assertionPassed = 0;
    for (const result of results) {
        const assertions = Array.isArray(result?.assertions) ? result.assertions : [];
        assertionCount += assertions.length;
        assertionPassed += assertions.filter((assertion) => assertion?.passed).length;
    }
    const passRate = passed / results.length;
    const assertionPassRate = assertionCount === 0 ? passRate : assertionPassed / assertionCount;
    return {
        score: (passRate * 0.8) + (assertionPassRate * 0.2),
        passRate,
        assertionPassRate,
        passed,
        total: results.length,
    };
}

/**
 * @param {Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>} promptTasks
 * @param {Array<Record<string, any>>} cases
 * @param {Record<string, any>} baselineReport
 */
export function buildHeuristicGepaPatches(promptTasks, cases, baselineReport) {
    /** @type {Record<string, { prompt: string; rationale: string; source: string }>} */
    const patches = {};
    const failedCaseIds = new Set((baselineReport.results ?? [])
        .filter((result) => !result.passed)
        .map((result) => result.caseId));
    for (const task of promptTasks) {
        const explicitPatch = cases
            .map((testCase) => isObject(testCase.metadata?.promptPatches)
            ? asString(testCase.metadata.promptPatches[task.nodeId])
            : null)
            .find(Boolean);
        if (explicitPatch) {
            patches[task.nodeId] = {
                prompt: explicitPatch,
                rationale: "Applied eval-case promptPatches metadata as a deterministic GEPA candidate.",
                source: "heuristic-gepa",
            };
            continue;
        }
        const hints = cases
            .filter((testCase) => failedCaseIds.size === 0 || failedCaseIds.has(testCase.id))
            .map((testCase) => isObject(testCase.metadata?.optimizationHints)
            ? asString(testCase.metadata.optimizationHints[task.nodeId])
            : null)
            .filter(Boolean);
        if (hints.length === 0) {
            continue;
        }
        const uniqueHints = [...new Set(hints)];
        patches[task.nodeId] = {
            prompt: [
                task.prompt.trimEnd(),
                "",
                "GEPA optimization notes:",
                ...uniqueHints.map((hint) => `- ${hint}`),
            ].join("\n"),
            rationale: "Reflected on failed validation cases and appended task-specific improvement hints.",
            source: "heuristic-gepa",
        };
    }
    return patches;
}

/**
 * @param {{
 *   apiKey?: string;
 *   model: string;
 *   promptTasks: Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>;
 *   cases: Array<Record<string, any>>;
 *   baselineReport: Record<string, any>;
 * }} input
 */
export async function buildCerebrasGepaPatches(input) {
    const apiKey = input.apiKey ?? process.env.CEREBRAS_API_KEY;
    if (!apiKey) {
        throw new SmithersError("INVALID_INPUT", "CEREBRAS_API_KEY is required for --provider cerebras.", {
            provider: "cerebras",
        });
    }
    const optimizerPrompt = [
        "You are GEPA optimizing Smithers workflow task prompts.",
        "Return only JSON: {\"patches\":[{\"nodeId\":\"...\",\"prompt\":\"...\",\"rationale\":\"...\"}]}",
        "Improve prompts to maximize validation pass rate while preserving task intent.",
        "",
        `Tasks: ${JSON.stringify(input.promptTasks)}`,
        `Eval cases: ${JSON.stringify(input.cases.map((testCase) => ({
            id: testCase.id,
            input: testCase.input,
            expected: testCase.expected,
            metadata: testCase.metadata,
        })))}`,
        `Baseline results: ${JSON.stringify(input.baselineReport.results ?? [])}`,
    ].join("\n");
    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: input.model,
            messages: [
                {
                    role: "system",
                    content: "You produce strict JSON and do not include Markdown fences.",
                },
                { role: "user", content: optimizerPrompt },
            ],
            temperature: 0.2,
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new SmithersError("INVALID_INPUT", `Cerebras optimizer request failed (${response.status}): ${body.slice(0, 500)}`, {
            provider: "cerebras",
            status: response.status,
        });
    }
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
        throw new SmithersError("INVALID_INPUT", "Cerebras optimizer response did not include message content.", {
            provider: "cerebras",
        });
    }
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
    const patchRows = Array.isArray(parsed?.patches) ? parsed.patches : [];
    /** @type {Record<string, { prompt: string; rationale: string; source: string }>} */
    const patches = {};
    for (const row of patchRows) {
        if (!isObject(row) || typeof row.nodeId !== "string" || typeof row.prompt !== "string") {
            continue;
        }
        patches[row.nodeId] = {
            prompt: row.prompt,
            rationale: typeof row.rationale === "string" ? row.rationale : "Cerebras GEPA prompt candidate.",
            source: "cerebras-gepa",
        };
    }
    return patches;
}

/**
 * @param {string} root
 * @param {string} workflowPath
 * @param {string | undefined} requestedPath
 */
export function resolveOptimizationArtifactPath(root, workflowPath, requestedPath) {
    if (requestedPath) {
        return isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath);
    }
    const workflowName = basename(workflowPath, extname(workflowPath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "workflow";
    return join(root, ".smithers", "optimizations", `${workflowName}-${Date.now().toString(36)}.json`);
}

/**
 * @param {{
 *   root: string;
 *   workflowPath: string;
 *   requestedPath?: string;
 *   provider: string;
 *   model: string;
 *   promptTasks: Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>;
 *   promptPatches: Record<string, { prompt: string; rationale?: string; source?: string }>;
 *   baselineReport: Record<string, any>;
 *   candidateReport: Record<string, any>;
 * }} input
 */
export function writeOptimizationArtifact(input) {
    const baseline = scoreOptimizationReport(input.baselineReport);
    const optimized = scoreOptimizationReport(input.candidateReport);
    const id = `opt-${crypto.randomUUID()}`;
    const artifact = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        id,
        strategy: "gepa",
        optimizer: {
            name: "smithers-ax-gepa",
            provider: input.provider,
            model: input.model,
            axCompatible: true,
            axArtifactKind: "AxGEPA.optimizedProgram",
        },
        workflowPath: input.workflowPath,
        createdAtMs: Date.now(),
        baseline,
        optimized,
        improvement: {
            absolute: optimized.score - baseline.score,
            relative: baseline.score === 0 ? null : (optimized.score - baseline.score) / baseline.score,
        },
        promptTasks: input.promptTasks,
        promptPatches: input.promptPatches,
        reports: {
            baseline: input.baselineReport.reportPath ?? null,
            optimized: input.candidateReport.reportPath ?? null,
        },
    };
    const target = resolveOptimizationArtifactPath(input.root, input.workflowPath, input.requestedPath);
    if (existsSync(target)) {
        throw new SmithersError("INVALID_INPUT", `Optimization artifact already exists: ${target}. Pass a different --artifact path.`, {
            path: target,
        });
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...artifact, artifactPath: target }, null, 2)}\n`, "utf8");
    return { artifact: { ...artifact, artifactPath: target }, path: target };
}

/**
 * @param {string} root
 * @param {Record<string, { prompt: string; rationale?: string; source?: string }>} promptPatches
 */
export function writeCandidateOptimizationArtifact(root, promptPatches) {
    const target = join(root, ".smithers", "optimizations", "candidates", `candidate-${crypto.randomUUID()}.json`);
    mkdirSync(dirname(target), { recursive: true });
    const artifact = {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        id: `candidate-${crypto.randomUUID()}`,
        strategy: "gepa",
        optimizer: {
            name: "smithers-ax-gepa",
            axCompatible: true,
            axArtifactKind: "AxGEPA.optimizedProgram",
        },
        createdAtMs: Date.now(),
        promptPatches,
    };
    writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return target;
}

/**
 * @param {Record<string, any>} report
 */
export function renderOptimizationReport(report) {
    const lines = [
        `Optimization: ${report.artifactPath ?? report.id}`,
        `Strategy: ${report.strategy}`,
        `Provider: ${report.optimizer?.provider ?? "unknown"} (${report.optimizer?.model ?? "unknown"})`,
        `Baseline: ${report.baseline.score.toFixed(4)} (${report.baseline.passed}/${report.baseline.total} passed)`,
        `Optimized: ${report.optimized.score.toFixed(4)} (${report.optimized.passed}/${report.optimized.total} passed)`,
        `Improvement: ${(report.improvement.absolute >= 0 ? "+" : "")}${report.improvement.absolute.toFixed(4)}`,
        "",
        "Prompt patches:",
    ];
    for (const [nodeId, patch] of Object.entries(report.promptPatches ?? {})) {
        lines.push(`- ${nodeId}: ${patch.source ?? "gepa"} (${String(patch.prompt ?? "").length} chars)`);
    }
    return lines.join("\n");
}
