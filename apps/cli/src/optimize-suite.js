import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import crypto from "node:crypto";
import { SmithersError } from "@smithers-orchestrator/errors";

const ARTIFACT_SCHEMA_VERSION = 1;
export const OPTIMIZER_PROVIDER_IDS = [
    "heuristic",
    "cerebras",
    "openai-api",
    "openai",
    "openai-sdk",
    "codex",
    "anthropic-api",
    "anthropic",
    "anthropic-sdk",
    "claude-code",
    "claude",
    "gemini-api",
    "gemini",
    "antigravity",
    "kimi",
    "moonshot",
    "opencode",
    "pi",
    "amp",
    "forge",
    "openai-compatible",
];
const PROVIDER_CONFIGS = {
    heuristic: { kind: "heuristic" },
    cerebras: {
        kind: "openai-compatible",
        baseURL: "https://api.cerebras.ai/v1",
        apiKeyEnv: "CEREBRAS_API_KEY",
        defaultModel: "gpt-oss-120b",
    },
    "openai-api": {
        kind: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
    },
    openai: {
        kind: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
    },
    "openai-sdk": {
        kind: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
    },
    codex: {
        kind: "openai-compatible",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        defaultModel: "gpt-5.3-codex",
    },
    "anthropic-api": {
        kind: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-opus-4-7",
    },
    anthropic: {
        kind: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-opus-4-7",
    },
    "anthropic-sdk": {
        kind: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-opus-4-7",
    },
    "claude-code": {
        kind: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-opus-4-7",
    },
    claude: {
        kind: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        defaultModel: "claude-opus-4-7",
    },
    "gemini-api": {
        kind: "gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        fallbackApiKeyEnv: "GOOGLE_API_KEY",
        defaultModel: "gemini-3.1-pro-preview",
    },
    gemini: {
        kind: "gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        fallbackApiKeyEnv: "GOOGLE_API_KEY",
        defaultModel: "gemini-3.1-pro-preview",
    },
    antigravity: {
        kind: "gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        fallbackApiKeyEnv: "GOOGLE_API_KEY",
        defaultModel: "gemini-3.1-pro-preview",
    },
    kimi: {
        kind: "openai-compatible",
        baseURL: "https://api.moonshot.ai/v1",
        apiKeyEnv: "MOONSHOT_API_KEY",
        defaultModel: "kimi-latest",
    },
    moonshot: {
        kind: "openai-compatible",
        baseURL: "https://api.moonshot.ai/v1",
        apiKeyEnv: "MOONSHOT_API_KEY",
        defaultModel: "kimi-latest",
    },
    opencode: {
        kind: "openai-compatible",
        baseURLEnv: "SMITHERS_OPTIMIZER_BASE_URL",
        apiKeyEnv: "SMITHERS_OPTIMIZER_API_KEY",
        defaultModel: "anthropic/claude-sonnet-4-5",
    },
    pi: {
        kind: "openai-compatible",
        baseURLEnv: "SMITHERS_OPTIMIZER_BASE_URL",
        apiKeyEnv: "SMITHERS_OPTIMIZER_API_KEY",
        defaultModel: "gpt-5.3-codex",
    },
    amp: {
        kind: "openai-compatible",
        baseURLEnv: "SMITHERS_OPTIMIZER_BASE_URL",
        apiKeyEnv: "SMITHERS_OPTIMIZER_API_KEY",
    },
    forge: {
        kind: "openai-compatible",
        baseURLEnv: "SMITHERS_OPTIMIZER_BASE_URL",
        apiKeyEnv: "SMITHERS_OPTIMIZER_API_KEY",
    },
    "openai-compatible": {
        kind: "openai-compatible",
        baseURLEnv: "SMITHERS_OPTIMIZER_BASE_URL",
        apiKeyEnv: "SMITHERS_OPTIMIZER_API_KEY",
    },
};

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
 * @param {string} provider
 */
export function getOptimizerProviderConfig(provider) {
    return PROVIDER_CONFIGS[provider] ?? null;
}

/**
 * @param {string} provider
 * @param {string | undefined} model
 */
export function resolveOptimizerProviderModel(provider, model) {
    const config = getOptimizerProviderConfig(provider);
    return model ?? config?.defaultModel ?? null;
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
 *   provider: string;
 *   apiKey?: string;
 *   baseURL?: string;
 *   model?: string;
 *   promptTasks: Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>;
 *   cases: Array<Record<string, any>>;
 *   baselineReport: Record<string, any>;
 * }} input
 * @param {{ fetch?: typeof fetch; env?: NodeJS.ProcessEnv }} [options]
 */
export async function buildProviderGepaPatches(input, options = {}) {
    const config = getOptimizerProviderConfig(input.provider);
    if (!config) {
        throw new SmithersError("INVALID_INPUT", `Unsupported optimizer provider "${input.provider}".`, {
            provider: input.provider,
            supportedProviders: OPTIMIZER_PROVIDER_IDS,
        });
    }
    if (config.kind === "heuristic") {
        return buildHeuristicGepaPatches(input.promptTasks, input.cases, input.baselineReport);
    }
    const env = options.env ?? process.env;
    const model = resolveOptimizerProviderModel(input.provider, input.model);
    if (!model) {
        throw new SmithersError("INVALID_INPUT", `--model is required for --provider ${input.provider}.`, {
            provider: input.provider,
        });
    }
    const apiKey = input.apiKey ?? env[config.apiKeyEnv] ?? (config.fallbackApiKeyEnv ? env[config.fallbackApiKeyEnv] : undefined);
    if (!apiKey) {
        const envNames = [config.apiKeyEnv, config.fallbackApiKeyEnv].filter(Boolean).join(" or ");
        throw new SmithersError("INVALID_INPUT", `${envNames} is required for --provider ${input.provider}.`, {
            provider: input.provider,
        });
    }
    const baseURL = input.baseURL ?? (config.baseURLEnv ? env[config.baseURLEnv] : undefined) ?? config.baseURL;
    if (!baseURL) {
        throw new SmithersError("INVALID_INPUT", `${config.baseURLEnv ?? "baseURL"} is required for --provider ${input.provider}.`, {
            provider: input.provider,
        });
    }
    const optimizerPrompt = buildOptimizerPrompt(input.promptTasks, input.cases, input.baselineReport);
    const fetchFn = options.fetch ?? fetch;
    const text = config.kind === "anthropic"
        ? await requestAnthropicOptimizer(fetchFn, { provider: input.provider, apiKey, baseURL, model, optimizerPrompt })
        : config.kind === "gemini"
            ? await requestGeminiOptimizer(fetchFn, { provider: input.provider, apiKey, baseURL, model, optimizerPrompt })
            : await requestOpenAICompatibleOptimizer(fetchFn, { provider: input.provider, apiKey, baseURL, model, optimizerPrompt });
    return parseOptimizerPatches(text, input.provider);
}

/**
 * @param {{
 *   apiKey?: string;
 *   model?: string;
 *   promptTasks: Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>;
 *   cases: Array<Record<string, any>>;
 *   baselineReport: Record<string, any>;
 * }} input
 * @param {{ fetch?: typeof fetch; env?: NodeJS.ProcessEnv }} [options]
 */
export async function buildCerebrasGepaPatches(input, options = {}) {
    return buildProviderGepaPatches({ provider: "cerebras", ...input }, options);
}

/**
 * @param {Array<ReturnType<typeof discoverOptimizablePromptTasks>[number]>} promptTasks
 * @param {Array<Record<string, any>>} cases
 * @param {Record<string, any>} baselineReport
 */
function buildOptimizerPrompt(promptTasks, cases, baselineReport) {
    return [
        "You are GEPA optimizing Smithers workflow task prompts.",
        "Return only JSON: {\"patches\":[{\"nodeId\":\"...\",\"prompt\":\"...\",\"rationale\":\"...\"}]}",
        "Improve prompts to maximize validation pass rate while preserving task intent.",
        "",
        `Tasks: ${JSON.stringify(promptTasks)}`,
        `Eval cases: ${JSON.stringify(cases.map((testCase) => ({
            id: testCase.id,
            input: testCase.input,
            expected: testCase.expected,
            metadata: testCase.metadata,
        })))}`,
        `Baseline results: ${JSON.stringify(baselineReport.results ?? [])}`,
    ].join("\n");
}

/**
 * @param {string} baseURL
 * @param {string} path
 */
function endpoint(baseURL, path) {
    return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * @param {typeof fetch} fetchFn
 * @param {{ provider: string; apiKey: string; baseURL: string; model: string; optimizerPrompt: string }} input
 */
async function requestOpenAICompatibleOptimizer(fetchFn, input) {
    const response = await fetchFn(endpoint(input.baseURL, "/chat/completions"), {
        method: "POST",
        headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: input.model,
            messages: [
                {
                    role: "system",
                    content: "You produce strict JSON and do not include Markdown fences.",
                },
                { role: "user", content: input.optimizerPrompt },
            ],
            temperature: 0.2,
        }),
    });
    await assertOptimizerResponseOk(response, input.provider);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
        throw new SmithersError("INVALID_INPUT", `${input.provider} optimizer response did not include message content.`, {
            provider: input.provider,
        });
    }
    return text;
}

/**
 * @param {typeof fetch} fetchFn
 * @param {{ provider: string; apiKey: string; baseURL: string; model: string; optimizerPrompt: string }} input
 */
async function requestAnthropicOptimizer(fetchFn, input) {
    const response = await fetchFn(endpoint(input.baseURL, "/messages"), {
        method: "POST",
        headers: {
            "x-api-key": input.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model: input.model,
            max_tokens: 4096,
            system: "You produce strict JSON and do not include Markdown fences.",
            messages: [{ role: "user", content: input.optimizerPrompt }],
            temperature: 0.2,
        }),
    });
    await assertOptimizerResponseOk(response, input.provider);
    const payload = await response.json();
    const text = payload?.content?.find((part) => part?.type === "text")?.text;
    if (typeof text !== "string") {
        throw new SmithersError("INVALID_INPUT", `${input.provider} optimizer response did not include text content.`, {
            provider: input.provider,
        });
    }
    return text;
}

/**
 * @param {typeof fetch} fetchFn
 * @param {{ provider: string; apiKey: string; baseURL: string; model: string; optimizerPrompt: string }} input
 */
async function requestGeminiOptimizer(fetchFn, input) {
    const url = `${endpoint(input.baseURL, `/models/${encodeURIComponent(input.model)}:generateContent`)}?key=${encodeURIComponent(input.apiKey)}`;
    const response = await fetchFn(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            systemInstruction: {
                parts: [{ text: "You produce strict JSON and do not include Markdown fences." }],
            },
            contents: [{ role: "user", parts: [{ text: input.optimizerPrompt }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
            },
        }),
    });
    await assertOptimizerResponseOk(response, input.provider);
    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => typeof part?.text === "string" ? part.text : "")
        .join("");
    if (typeof text !== "string" || !text.trim()) {
        throw new SmithersError("INVALID_INPUT", `${input.provider} optimizer response did not include text content.`, {
            provider: input.provider,
        });
    }
    return text;
}

/**
 * @param {Response} response
 * @param {string} provider
 */
async function assertOptimizerResponseOk(response, provider) {
    if (response.ok) {
        return;
    }
    const body = await response.text();
    throw new SmithersError("INVALID_INPUT", `${provider} optimizer request failed (${response.status}): ${body.slice(0, 500)}`, {
        provider,
        status: response.status,
    });
}

/**
 * @param {string} text
 * @param {string} provider
 */
function parseOptimizerPatches(text, provider) {
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
            rationale: typeof row.rationale === "string" ? row.rationale : `${provider} GEPA prompt candidate.`,
            source: `${provider}-gepa`,
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
            name: "smithers-gepa",
            provider: input.provider,
            model: input.model,
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
            name: "smithers-gepa",
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
