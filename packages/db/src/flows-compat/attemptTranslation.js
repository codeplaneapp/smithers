/**
 * Translation between a `_smithers_attempts` row and a flows `AttemptStore`
 * attempt, and back.
 *
 * flows keys an attempt by `(runId, stepKeyDigest, attempt)`; Smithers keys it
 * by `(runId, nodeId, iteration, attempt)`. `stepKeyDigest` is a content hash on
 * the flows side, and stage 1.2 is what makes Smithers node identity produce
 * one, so until then the digest is derived from the Smithers key. `nodeId` and
 * `iteration` travel in `meta` so the reverse direction reconstructs the row
 * without inverting the digest.
 *
 * Every Smithers-only column also travels in `meta`. flows persists `meta`
 * unchanged across attempt state changes, which is what lets one flows row
 * carry a Smithers row losslessly.
 */
import { sha256Hex } from "../sha256Hex.js";

/** Columns of `_smithers_attempts` that flows models as first-class fields. */
const FLOWS_NATIVE_COLUMNS = new Set([
  "runId",
  "nodeId",
  "iteration",
  "attempt",
  "state",
  "startedAtMs",
  "finishedAtMs",
  "heartbeatAtMs",
  "errorJson",
]);

/**
 * The flows step-key digest for a Smithers node iteration.
 *
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function attemptStepKeyDigest(nodeId, iteration) {
  return sha256Hex(`smithers-node ${nodeId} ${Number(iteration)}`);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function decodeJsonColumn(value) {
  if (typeof value !== "string") return value ?? undefined;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
}

/**
 * Translate a `_smithers_attempts` row into a flows attempt.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function toFlowsAttempt(row) {
  const nodeId = String(row.nodeId);
  const iteration = Number(row.iteration ?? 0);
  /** @type {Record<string, unknown>} */
  const extras = {};
  for (const [key, value] of Object.entries(row)) {
    if (FLOWS_NATIVE_COLUMNS.has(key)) continue;
    extras[key] = value;
  }
  /** @type {Record<string, unknown>} */
  const attempt = {
    runId: String(row.runId),
    stepKeyDigest: attemptStepKeyDigest(nodeId, iteration),
    attempt: Number(row.attempt),
    state: String(row.state),
    startedAtMs: Number(row.startedAtMs ?? 0),
    meta: { nodeId, iteration, columns: extras },
  };
  if (row.finishedAtMs !== null && row.finishedAtMs !== undefined) attempt.finishedAtMs = Number(row.finishedAtMs);
  if (row.heartbeatAtMs !== null && row.heartbeatAtMs !== undefined) attempt.heartbeatAtMs = Number(row.heartbeatAtMs);
  if (row.errorJson !== null && row.errorJson !== undefined) attempt.error = decodeJsonColumn(row.errorJson);
  return attempt;
}

/**
 * Translate a flows attempt back into a `_smithers_attempts` row.
 *
 * @param {Record<string, unknown>} attempt
 * @returns {Record<string, unknown>}
 */
export function toSmithersAttemptRow(attempt) {
  const meta = /** @type {{ nodeId?: unknown; iteration?: unknown; columns?: Record<string, unknown> }} */ (
    attempt.meta !== null && typeof attempt.meta === "object" ? attempt.meta : {}
  );
  /** @type {Record<string, unknown>} */
  const row = {
    runId: String(attempt.runId),
    nodeId: String(meta.nodeId ?? ""),
    iteration: Number(meta.iteration ?? 0),
    attempt: Number(attempt.attempt),
    state: String(attempt.state),
    startedAtMs: Number(attempt.startedAtMs ?? 0),
    finishedAtMs: attempt.finishedAtMs ?? null,
    heartbeatAtMs: attempt.heartbeatAtMs ?? null,
    errorJson: attempt.error === undefined ? null : JSON.stringify(attempt.error),
  };
  for (const [key, value] of Object.entries(meta.columns ?? {})) {
    row[key] = value;
  }
  return row;
}
