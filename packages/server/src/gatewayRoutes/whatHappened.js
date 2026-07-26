// The `whatHappened` RPC answers "what happened here?" for a run or one node
// of it. The Gateway itself never talks to an LLM: a host (e.g. the smithers
// CLI) may inject a narrator via the Gateway `whatHappened` option, and without
// one this route degrades to a deterministic fact summary read from the DB.
// Terminal targets are cached per state fingerprint so repeated clicks in the
// monitor UI do not re-pay the narrator.

import { RUN_ID_PATTERN } from "./RUN_ID_PATTERN.js";

const NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
const INT32_MAX = 2_147_483_647;
const CACHE_MAX_ENTRIES = 200;
const TERMINAL_STATES = new Set(["finished", "failed", "cancelled"]);

export class WhatHappenedRouteError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WhatHappenedRouteError";
    this.code = code;
  }
}

/**
 * @param {number | null | undefined} start
 * @param {number | null | undefined} end
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
 * @param {unknown} value
 */
function asString(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function coerceOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    return undefined;
  }
  return numeric;
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
      const message = asString(parsed.message) ?? asString(parsed.summary);
      return (message ?? raw).slice(0, 400);
    }
    return String(parsed).slice(0, 400);
  } catch {
    return raw.slice(0, 400);
  }
}

/**
 * Deterministic no-narrator summary for one node, from its iteration row and
 * attempts.
 *
 * @param {{ nodeId: string; state: string; attempts: Array<{ state?: string; errorJson?: unknown; startedAtMs?: unknown; finishedAtMs?: unknown }> }} params
 */
function fallbackNodeSummary(params) {
  const attemptCount = params.attempts.length;
  const started = params.attempts.map((attempt) => Number(attempt.startedAtMs)).filter(Number.isFinite);
  const finished = params.attempts.map((attempt) => Number(attempt.finishedAtMs)).filter(Number.isFinite);
  const duration = formatDuration(
    started.length ? Math.min(...started) : null,
    finished.length ? Math.max(...finished) : null,
  );
  const lines = [
    `Node "${params.nodeId}" ${params.state} after ${attemptCount} attempt${attemptCount === 1 ? "" : "s"} in ${duration}.`,
  ];
  const lastError = [...params.attempts]
    .reverse()
    .map((attempt) => parseErrorMessage(asString(attempt.errorJson)))
    .find(Boolean);
  if (lastError) lines.push(`- error: ${lastError}`);
  return lines.join("\n");
}

/**
 * Deterministic no-narrator summary for a whole run, from its run row.
 *
 * @param {{ runId: string; workflowName?: unknown; status?: unknown; createdAtMs?: unknown; startedAtMs?: unknown; finishedAtMs?: unknown; errorJson?: unknown }} run
 */
function fallbackRunSummary(run) {
  const workflowName = asString(run.workflowName) ?? "workflow";
  const status = asString(run.status) ?? "unknown";
  const duration = formatDuration(
    Number(run.startedAtMs ?? run.createdAtMs) || null,
    Number(run.finishedAtMs) || Date.now(),
  );
  const lines = [`Run ${run.runId} (${workflowName}) ${status} in ${duration}.`];
  const error = parseErrorMessage(asString(run.errorJson));
  if (error) lines.push(`- run error: ${error}`);
  return lines.join("\n");
}

/**
 * Summarize what happened in a run or node. `summarize` is the host-injected
 * narrator (`null` for none); its failures are swallowed in favor of the
 * deterministic fact summary so this RPC never breaks on a missing or flaky
 * agent.
 *
 * @param {{
 *   runId: unknown;
 *   nodeId: unknown;
 *   iteration: unknown;
 *   resolveRun: (runId: string) => Promise<{ workflow: unknown; adapter: import("@smithers-orchestrator/db/adapter").SmithersDb } | null>;
 *   summarize?: ((params: { runId: string; nodeId: string | null; iteration: number | null; adapter: import("@smithers-orchestrator/db/adapter").SmithersDb }) => Promise<{ summary: string; agentId?: string | null; source?: "agent" | "facts" } | null>) | null;
 *   cache?: Map<string, { payload: Record<string, unknown> }>;
 *   now?: () => number;
 * }} params
 * @returns {Promise<import("@smithers-orchestrator/gateway/rpc").WhatHappenedResponse>}
 */
export async function whatHappenedRoute(params) {
  const now = params.now ?? Date.now;
  const runId = asString(params.runId);
  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    throw new WhatHappenedRouteError("InvalidRunId", "runId must match /^[a-z0-9_-][a-z0-9_.-]{0,63}$/.");
  }
  const nodeId = params.nodeId === undefined || params.nodeId === null ? null : (asString(params.nodeId) ?? "");
  if (nodeId !== null && !NODE_ID_PATTERN.test(nodeId)) {
    throw new WhatHappenedRouteError("InvalidNodeId", "nodeId must match /^[a-zA-Z0-9:_-]{1,128}$/.");
  }
  const requestedIteration = coerceOptionalInteger(params.iteration);
  if (
    params.iteration !== undefined &&
    params.iteration !== null &&
    params.iteration !== "" &&
    (requestedIteration === undefined || requestedIteration < 0 || requestedIteration > INT32_MAX)
  ) {
    throw new WhatHappenedRouteError("InvalidIteration", "iteration must be a non-negative 32-bit integer.");
  }

  const resolved = await params.resolveRun(runId);
  if (!resolved) {
    throw new WhatHappenedRouteError("RunNotFound", `Run not found: ${runId}`);
  }
  const adapter = resolved.adapter;
  const run = await adapter.getRun(runId);
  if (!run) {
    throw new WhatHappenedRouteError("RunNotFound", `Run not found: ${runId}`);
  }

  let iteration = null;
  let state;
  let fingerprint;
  let fallbackSummary;
  if (nodeId !== null) {
    const nodeIterations = await adapter.listNodeIterations(runId, nodeId);
    if (!Array.isArray(nodeIterations) || nodeIterations.length === 0) {
      throw new WhatHappenedRouteError("NodeNotFound", `Node not found: ${nodeId}`);
    }
    iteration = requestedIteration ?? Math.max(...nodeIterations.map((row) => row?.iteration ?? 0));
    const node = nodeIterations.find((row) => (row?.iteration ?? 0) === iteration);
    if (!node) {
      throw new WhatHappenedRouteError("IterationNotFound", `Iteration not found: ${iteration}`);
    }
    state = String(node.state ?? "unknown");
    fingerprint = `node:${state}:${node.lastAttempt ?? ""}:${node.updatedAtMs ?? ""}`;
    const attempts = await adapter.listAttempts(runId, nodeId, iteration);
    fallbackSummary = fallbackNodeSummary({ nodeId, state, attempts: Array.isArray(attempts) ? attempts : [] });
  } else {
    state = String(run.status ?? "unknown");
    fingerprint = `run:${state}:${run.finishedAtMs ?? ""}`;
    fallbackSummary = fallbackRunSummary({ ...run, runId });
  }

  const cacheable = TERMINAL_STATES.has(state) && params.cache instanceof Map;
  const cacheKey = `${runId}\0${nodeId ?? ""}\0${iteration ?? ""}\0${fingerprint}`;
  if (cacheable) {
    const hit = params.cache.get(cacheKey);
    if (hit) {
      return /** @type {import("@smithers-orchestrator/gateway/rpc").WhatHappenedResponse} */ ({
        ...hit.payload,
        cached: true,
      });
    }
  }

  let summary = null;
  let agentId = null;
  let source = "facts";
  if (typeof params.summarize === "function") {
    try {
      const narrated = await params.summarize({ runId, nodeId, iteration, adapter });
      if (narrated && typeof narrated.summary === "string" && narrated.summary.trim()) {
        summary = narrated.summary.trim();
        agentId = asString(narrated.agentId) ?? null;
        source = narrated.source === "facts" ? "facts" : "agent";
      }
    } catch {
      /* The deterministic fallback below always answers. */
    }
  }
  if (!summary) {
    summary = fallbackSummary;
    agentId = null;
    source = "facts";
  }

  const payload = {
    runId,
    nodeId,
    iteration,
    scope: nodeId === null ? "run" : "node",
    summary,
    agentId,
    source,
    cached: false,
    generatedAtMs: now(),
  };
  if (cacheable) {
    params.cache.set(cacheKey, { payload });
    if (params.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = params.cache.keys().next().value;
      if (oldest !== undefined) params.cache.delete(oldest);
    }
  }
  return /** @type {import("@smithers-orchestrator/gateway/rpc").WhatHappenedResponse} */ (payload);
}
