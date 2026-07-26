// @smithers-type-exports-begin
/** @typedef {import("./HumanRequestKind.ts").HumanRequestKind} HumanRequestKind */
/** @typedef {import("./HumanRequestStatus.ts").HumanRequestStatus} HumanRequestStatus */
// @smithers-type-exports-end

import { jsonSchemaToZodType } from "./external/json-schema-to-zod.js";
/**
 * @typedef {{ ok: true; } | { ok: false; code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED"; message: string; }} HumanRequestSchemaValidation
 */

/** @type {readonly ["ask", "confirm", "select", "json"]} */
export const HUMAN_REQUEST_KINDS = ["ask", "confirm", "select", "json"];
/** @type {readonly ["pending", "answered", "cancelled", "expired"]} */
export const HUMAN_REQUEST_STATUSES = ["pending", "answered", "cancelled", "expired"];
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildHumanRequestId(runId, nodeId, iteration) {
  return `human:${runId}:${nodeId}:${iteration}`;
}
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {boolean}
 */
export function isHumanTaskMeta(meta) {
  return Boolean(meta?.humanTask);
}
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} fallback
 * @returns {string}
 */
export function getHumanTaskPrompt(meta, fallback) {
  const prompt = meta?.prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt : fallback;
}
/**
 * @param {{ timeoutAtMs?: number | null } | null | undefined} request
 * @returns {boolean}
 */
export function isHumanRequestPastTimeout(request, nowMs = Date.now()) {
  return (
    typeof request?.timeoutAtMs === "number" && Number.isFinite(request.timeoutAtMs) && request.timeoutAtMs <= nowMs
  );
}
/**
 * @param {{ issues?: Array<{ path?: PropertyKey[]; message?: string }> }} error
 */
function formatValidationIssues(error) {
  const issues = error.issues ?? [];
  if (issues.length === 0) {
    return "unknown validation error";
  }
  return issues
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message ?? "invalid value"}`;
    })
    .join("; ");
}
/**
 * @param {{ requestId: string; schemaJson: string | null }} request
 * @param {unknown} value
 * @returns {HumanRequestSchemaValidation}
 */
export function validateHumanRequestValue(request, value) {
  if (!request.schemaJson) {
    return { ok: true };
  }
  let schema;
  try {
    schema = JSON.parse(request.schemaJson);
  } catch (err) {
    return {
      ok: false,
      code: "HUMAN_REQUEST_SCHEMA_INVALID",
      message: `Stored schema for ${request.requestId} is not valid JSON: ${err?.message ?? String(err)}`,
    };
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      ok: false,
      code: "HUMAN_REQUEST_SCHEMA_INVALID",
      message: `Stored schema for ${request.requestId} is not a JSON object.`,
    };
  }
  let validator;
  try {
    validator = jsonSchemaToZodType(schema);
  } catch (err) {
    return {
      ok: false,
      code: "HUMAN_REQUEST_SCHEMA_INVALID",
      message: `Stored schema for ${request.requestId} could not be loaded for validation: ${err?.message ?? String(err)}`,
    };
  }
  const result = validator.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      code: "HUMAN_REQUEST_VALIDATION_FAILED",
      message: `Human request ${request.requestId} does not match the stored schema: ${formatValidationIssues(result.error)}`,
    };
  }
  return { ok: true };
}
/**
 * Default node id used when an agent raises an ad-hoc human request mid-task and
 * no node context (env/flag) is available. listPendingHumanRequests LEFT-JOINs
 * nodes, so a synthetic node id still surfaces in `smithers human inbox`.
 * @type {string}
 */
export const DEFAULT_AGENT_ASK_NODE_ID = "agent-ask";

/**
 * Build a unique request id for an ad-hoc, agent-initiated human ask.
 *
 * Unlike {@link buildHumanRequestId} (deterministic per run/node/iteration, used by
 * the declarative HumanTask node), an agent may raise more than one block per
 * node/iteration, so its ids must be unique. The caller supplies the uniqueness
 * token (e.g. a timestamp+random suffix) to keep this function pure/testable.
 *
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} unique
 * @returns {string}
 */
export function buildAgentAskRequestId(runId, nodeId, iteration, unique) {
  return `human:${runId}:${nodeId}:${iteration}:${unique}`;
}
/**
 * @typedef {object} BuildAgentAskRequestInput
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} iteration
 * @property {string} prompt
 * @property {string} unique
 * @property {number} requestedAtMs
 * @property {HumanRequestKind} [kind]
 * @property {string | null} [schemaJson]
 * @property {string | null} [optionsJson]
 * @property {number | null} [timeoutAtMs]
 */
/**
 * Build the `_smithers_human_requests` row for an agent-initiated ask. The row is
 * `pending` and carries no approval, so `smithers human answer/cancel` resolves it
 * directly without touching the approval-node machinery.
 *
 * @param {BuildAgentAskRequestInput} input
 * @returns {Record<string, unknown>}
 */
export function buildAgentAskRequestRow(input) {
  return {
    requestId: buildAgentAskRequestId(input.runId, input.nodeId, input.iteration, input.unique),
    runId: input.runId,
    nodeId: input.nodeId,
    iteration: input.iteration,
    kind: input.kind ?? "ask",
    status: "pending",
    prompt: input.prompt,
    schemaJson: input.schemaJson ?? null,
    optionsJson: input.optionsJson ?? null,
    responseJson: null,
    requestedAtMs: input.requestedAtMs,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: input.timeoutAtMs ?? null,
  };
}
/**
 * @param {string} status
 * @returns {boolean}
 */
export function isResolvedHumanRequestStatus(status) {
  return status === "answered" || status === "cancelled" || status === "expired";
}
/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultPollSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    /** @type {(() => void) | undefined} */
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
/**
 * @typedef {object} HumanAnswerOutcome
 * @property {"answered" | "cancelled" | "expired" | "missing" | "aborted"} status
 * @property {string | null} [responseJson]
 * @property {string | null} [answeredBy]
 */
/**
 * Block until a pending human request is resolved (answered / cancelled / expired),
 * polling the durable store. Reusable by the CLI, the MCP `ask_human` tool, or any
 * other caller that needs to wait on a human decision. Pure poll loop — the only
 * dependency is a duck-typed adapter with `getHumanRequest` + `expireStaleHumanRequests`.
 *
 * @param {{ getHumanRequest: (id: string) => Promise<any>, expireStaleHumanRequests: (nowMs?: number) => Promise<unknown> }} adapter
 * @param {string} requestId
 * @param {object} [options]
 * @param {number} [options.pollIntervalMs]
 * @param {AbortSignal} [options.signal]
 * @param {() => number} [options.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @returns {Promise<HumanAnswerOutcome>}
 */
export async function waitForHumanAnswer(adapter, requestId, options = {}) {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 3_000);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultPollSleep;
  for (;;) {
    if (options.signal?.aborted) {
      return { status: "aborted" };
    }
    await adapter.expireStaleHumanRequests(now());
    const request = await adapter.getHumanRequest(requestId);
    if (!request) {
      return { status: "missing" };
    }
    if (request.status !== "pending") {
      return {
        status: request.status,
        responseJson: request.responseJson ?? null,
        answeredBy: request.answeredBy ?? null,
      };
    }
    await sleep(pollIntervalMs, options.signal);
  }
}
export const __humanRequestInternals = {
  formatValidationIssues,
  defaultPollSleep,
};
