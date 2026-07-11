import { SmithersError } from "@smithers-orchestrator/errors";
import { listNarratorCandidates } from "./narrator-agents.js";
import { aggregateNodeDetailEffect } from "./node-detail.js";
import { runPromise } from "./smithersRuntime.js";

// `smithers what` answers "what happened here?" for a run or a single node: a
// cheap fast agent reads a bounded factual transcript and replies with a short
// plain-text recap. Everything degrades gracefully — with no usable agent (or a
// narrator failure) the caller still gets a deterministic fact summary, so the
// command and the monitor UI never break on a missing agent.

const MAX_CONTEXT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const WHAT_SYSTEM_PROMPT = [
    "You explain what happened in one Smithers workflow run (or one node of a run) to a human who just clicked on it.",
    "You are given the facts: status, timing, attempts, errors, outputs. You have no tools and must not ask for more; work only from what you are given, and never invent details.",
    "Reply with plain text only: no markdown symbols (#, *, `), no code fences, no ANSI codes.",
    "Shape: first line is one sentence stating the outcome (what ran and how it ended), then 2-6 short dashed bullets with the key things that happened — important results, retries, errors and their causes, notable outputs.",
    "Keep the whole reply under 120 words. If something failed, name the failing step and quote the decisive error message briefly.",
    "Output the reply directly with no preamble and nothing after it.",
].join("\n");

/**
 * @param {number | null | undefined} start
 * @param {number | null | undefined} end
 * @returns {string}
 */
function formatDuration(start, end) {
    if (!start || !end || end < start) return "unknown";
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
function parseErrorMessage(raw) {
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const message = typeof parsed.message === "string" ? parsed.message : typeof parsed.summary === "string" ? parsed.summary : null;
            return message ? message.slice(0, 400) : raw.slice(0, 400);
        }
        return String(parsed).slice(0, 400);
    }
    catch {
        return raw.slice(0, 400);
    }
}

/**
 * @param {string} text
 * @param {number} max
 */
function trimText(text, max) {
    const normalized = text.trim().replace(/\s+/g, " ");
    return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * Bounded factual context for a whole run: run row + lifecycle counts +
 * per-node output text from the event log.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 */
async function buildRunContext(adapter, runId) {
    const run = await adapter.getRun(runId);
    if (!run) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
    }
    const workflowName = run.workflowName ?? "workflow";
    const status = String(run.status ?? "unknown");
    const duration = formatDuration(run.startedAtMs ?? run.createdAtMs, run.finishedAtMs ?? Date.now());
    const runError = parseErrorMessage(run.errorJson ?? null);
    /** @type {Map<string, string>} */
    const nodeText = new Map();
    /** @type {Map<string, string>} */
    const nodeState = new Map();
    try {
        const events = await adapter.listEvents(runId, 0, 2000);
        for (const event of events) {
            let payload;
            try {
                payload = JSON.parse(event.payloadJson ?? event.payload_json ?? "{}");
            }
            catch {
                continue;
            }
            const nodeId = String(payload.nodeId ?? "");
            if (!nodeId) continue;
            if (event.type === "NodeOutput" && typeof payload.text === "string" && payload.text.trim()) {
                nodeText.set(nodeId, `${nodeText.get(nodeId) ?? ""}${payload.text}`);
            }
            else if (event.type === "NodeFinished") {
                nodeState.set(nodeId, "finished");
            }
            else if (event.type === "NodeFailed") {
                const error = parseErrorMessage(typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error ?? null));
                nodeState.set(nodeId, error ? `failed: ${error}` : "failed");
            }
            else if (event.type === "NodeStarted" && !nodeState.has(nodeId)) {
                nodeState.set(nodeId, "started");
            }
        }
    }
    catch {
        /* events are best-effort */
    }
    const failedNodes = [...nodeState.entries()].filter(([, state]) => state.startsWith("failed"));
    const lines = [];
    lines.push(`Run: ${runId} (workflow ${workflowName})`);
    lines.push(`Status: ${status}`);
    lines.push(`Duration: ${duration}`);
    if (runError) lines.push(`Run error: ${runError}`);
    if (nodeState.size > 0) {
        lines.push("");
        lines.push("Steps:");
        for (const [nodeId, state] of nodeState) {
            const text = nodeText.get(nodeId);
            lines.push(`- ${nodeId}: ${state}${text ? ` — ${trimText(text, 600)}` : ""}`);
        }
    }
    return {
        context: lines.join("\n"),
        facts: {
            scope: /** @type {const} */ ("run"),
            runId,
            nodeId: null,
            iteration: null,
            workflowName,
            status,
            duration,
            nodeCount: nodeState.size,
            failedNodes: failedNodes.map(([nodeId, state]) => ({ nodeId, error: state.replace(/^failed:?\s*/, "") || null })),
            error: runError,
        },
    };
}

/**
 * Bounded factual context for one node: state, attempts, errors, tool usage,
 * agent response, and validated output.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number | undefined} iteration
 */
async function buildNodeContext(adapter, runId, nodeId, iteration) {
    const run = await adapter.getRun(runId);
    if (!run) {
        throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
    }
    const workflowName = run.workflowName ?? "workflow";
    const detail = await runPromise(aggregateNodeDetailEffect(adapter, { runId, nodeId, iteration }));
    const status = String(detail.status ?? "unknown");
    const duration = detail.durationMs != null ? formatDuration(0, detail.durationMs) : "unknown";
    const attempts = detail.attempts ?? [];
    const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
    const lastError = [...attempts].reverse().map((attempt) => attempt.error).find(Boolean) ?? null;
    const lines = [];
    lines.push(`Node: ${nodeId} (iteration ${detail.node.iteration}) in run ${runId} (workflow ${workflowName})`);
    if (detail.node.label) lines.push(`Label: ${detail.node.label}`);
    lines.push(`State: ${status}`);
    lines.push(`Duration: ${duration}`);
    lines.push(`Attempts: ${attempts.length}${failedAttempts.length ? ` (${failedAttempts.length} failed)` : ""}`);
    for (const attempt of attempts) {
        const parts = [`Attempt ${attempt.attempt} ${attempt.state}`];
        if (attempt.durationMs != null) parts.push(`in ${formatDuration(0, attempt.durationMs)}`);
        if (attempt.error) parts.push(`— error: ${trimText(attempt.error, 400)}`);
        if (attempt.toolCalls.length > 0) {
            /** @type {Map<string, number>} */
            const toolCounts = new Map();
            for (const call of attempt.toolCalls) {
                toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
            }
            parts.push(`— tools: ${[...toolCounts.entries()].map(([name, count]) => `${name} x${count}`).join(", ")}`);
        }
        lines.push(parts.join(" "));
        if (attempt.responseText) {
            lines.push(`  Agent response: ${trimText(attempt.responseText, 1_200)}`);
        }
    }
    const output = detail.output?.validated ?? detail.output?.raw ?? null;
    if (output != null) {
        let rendered;
        try {
            rendered = typeof output === "string" ? output : JSON.stringify(output);
        }
        catch {
            rendered = String(output);
        }
        lines.push(`Output: ${trimText(rendered, 1_500)}`);
    }
    return {
        context: lines.join("\n"),
        facts: {
            scope: /** @type {const} */ ("node"),
            runId,
            nodeId,
            iteration: detail.node.iteration,
            workflowName,
            status,
            duration,
            attemptCount: attempts.length,
            failedAttemptCount: failedAttempts.length,
            toolCallCount: (detail.toolCalls ?? []).length,
            hasOutput: output != null,
            error: lastError ? trimText(lastError, 400) : null,
        },
    };
}

/**
 * Assemble the bounded factual context the narrator reads. Run-scoped when
 * `nodeId` is absent, node-scoped otherwise. Throws SmithersError
 * RUN_NOT_FOUND / NODE_NOT_FOUND for a missing target.
 *
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {{ runId: string; nodeId?: string | null; iteration?: number }} params
 * @returns {Promise<{ context: string; facts: WhatHappenedFacts }>}
 */
export async function buildWhatContext(adapter, params) {
    const built = params.nodeId
        ? await buildNodeContext(adapter, params.runId, params.nodeId, params.iteration)
        : await buildRunContext(adapter, params.runId);
    if (built.context.length > MAX_CONTEXT_CHARS) {
        built.context = `${built.context.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)`;
    }
    return built;
}

/**
 * @typedef {{ scope: "run"; runId: string; nodeId: null; iteration: null; workflowName: string; status: string; duration: string; nodeCount: number; failedNodes: Array<{ nodeId: string; error: string | null }>; error: string | null }
 *   | { scope: "node"; runId: string; nodeId: string; iteration: number; workflowName: string; status: string; duration: string; attemptCount: number; failedAttemptCount: number; toolCallCount: number; hasOutput: boolean; error: string | null }} WhatHappenedFacts
 */

/**
 * Deterministic recap used when no narrator agent is available (or every
 * candidate failed). Plain but honest, so `smithers what` always answers.
 *
 * @param {WhatHappenedFacts} facts
 * @returns {string}
 */
export function renderWhatFallback(facts) {
    if (facts.scope === "node") {
        const lines = [`Node "${facts.nodeId}" ${facts.status} after ${facts.attemptCount} attempt${facts.attemptCount === 1 ? "" : "s"} in ${facts.duration}.`];
        if (facts.error) lines.push(`- error: ${facts.error}`);
        if (facts.toolCallCount > 0) lines.push(`- made ${facts.toolCallCount} tool call${facts.toolCallCount === 1 ? "" : "s"}`);
        if (facts.hasOutput) lines.push("- produced structured output");
        return lines.join("\n");
    }
    const lines = [`Run ${facts.runId} (${facts.workflowName}) ${facts.status} in ${facts.duration}; ${facts.nodeCount} step${facts.nodeCount === 1 ? "" : "s"} recorded.`];
    if (facts.error) lines.push(`- run error: ${facts.error}`);
    for (const failed of facts.failedNodes.slice(0, 5)) {
        lines.push(`- step "${failed.nodeId}" failed${failed.error ? `: ${failed.error}` : ""}`);
    }
    return lines.join("\n");
}

/**
 * Normalize the narrator's reply: strip code fences and markdown wrapping,
 * bound the length, and reject an empty answer so the caller falls back.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function cleanWhatSummary(text) {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    if (!cleaned) return null;
    if (cleaned.length > MAX_SUMMARY_CHARS) {
        cleaned = `${cleaned.slice(0, MAX_SUMMARY_CHARS)}…`;
    }
    return cleaned;
}

/**
 * Explain what happened in a run or node: build the bounded context, ask the
 * cheapest usable narrator agent (Codex/`gpt-5.6-luna` first), and fall back
 * to a deterministic fact recap when no agent answers. Only a missing target
 * throws (RUN_NOT_FOUND / NODE_NOT_FOUND); narrator failures never do.
 *
 * @param {{
 *   adapter: import("@smithers-orchestrator/db/adapter").SmithersDb;
 *   runId: string;
 *   nodeId?: string | null;
 *   iteration?: number;
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   timeoutMs?: number;
 *   candidates?: Array<{ id: string; build: (systemPrompt: string) => { generate: (params: { prompt: string; timeout?: { totalMs: number } }) => Promise<unknown> } }>;
 * }} params
 * @returns {Promise<{ summary: string; agentId: string | null; source: "agent" | "facts"; facts: WhatHappenedFacts }>}
 */
export async function whatHappened(params) {
    const env = params.env ?? process.env;
    const cwd = params.cwd ?? process.cwd();
    const { context, facts } = await buildWhatContext(params.adapter, {
        runId: params.runId,
        nodeId: params.nodeId,
        iteration: params.iteration,
    });
    const candidates = params.candidates ?? listNarratorCandidates(env, cwd);
    for (const candidate of candidates) {
        try {
            const agent = candidate.build(WHAT_SYSTEM_PROMPT);
            const generated = await agent.generate({
                prompt: `Explain what happened here:\n\n${context}`,
                timeout: { totalMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
            });
            const responseText = typeof generated === "string" ? generated : (generated?.text ?? "");
            const summary = cleanWhatSummary(responseText);
            if (summary) {
                return { summary, agentId: candidate.id, source: "agent", facts };
            }
        }
        catch {
            /* Try the next Codex account, then non-Codex fallbacks. */
        }
    }
    return { summary: renderWhatFallback(facts), agentId: null, source: "facts", facts };
}
