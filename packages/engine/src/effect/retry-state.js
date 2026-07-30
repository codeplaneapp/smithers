import { createDurableRetryState } from "@smithers-orchestrator/scheduler";

export const RETRY_STATE_META_KEY = "retryState";

/** @param {unknown} value */
function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} error */
function isQuotaFailurePayload(error) {
  if (error.code === "AGENT_QUOTA_EXCEEDED") return true;
  const details = error.details;
  return Boolean(
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    /** @type {Record<string, unknown>} */ (details).failureQuota === true,
  );
}

/** @param {{ errorJson?: string | null; metaJson?: string | null }} attempt */
function isQuotaAttempt(attempt) {
  const error = parseJsonObject(attempt.errorJson);
  if (error && isQuotaFailurePayload(error)) return true;
  return parseJsonObject(attempt.metaJson)?.failureQuota === true;
}

/** @param {Record<string, unknown>} error */
function retryAfterMs(error) {
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return 0;
  const value = /** @type {Record<string, unknown>} */ (details).retryAfterMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Stamp the exact retry rung and absolute deadline into attempt meta before
 * the attempt's terminal transaction. Returns null for quota, terminal, and
 * exhausted failures.
 *
 * @param {{
 *   attemptMeta: Record<string, any>;
 *   attempts: ReadonlyArray<{ state?: string | null; errorJson?: string | null; metaJson?: string | null }>;
 *   descriptor: { retries: number; retryPolicy?: import("@smithers-orchestrator/scheduler").RetryPolicy };
 *   error: Record<string, unknown>;
 *   failedAtMs: number;
 * }} input
 */
export function stampDurableRetryState(input) {
  if (isQuotaFailurePayload(input.error)) return null;
  const failureCount =
    input.attempts.filter((attempt) => attempt.state === "failed" && !isQuotaAttempt(attempt)).length + 1;
  const code = typeof input.error.code === "string" ? input.error.code : null;
  const kind = typeof input.attemptMeta.kind === "string" ? input.attemptMeta.kind : null;
  const retryable =
    input.attemptMeta.failureRetryable === true ||
    (input.attemptMeta.failureRetryable !== false &&
      code !== "AGENT_CONFIG_INVALID" &&
      !(kind !== "agent" && code === "INVALID_OUTPUT"));
  if (!retryable || (input.descriptor.retries !== Infinity && failureCount > input.descriptor.retries)) {
    return null;
  }
  const retryState = createDurableRetryState({
    failureCount,
    failedAtMs: input.failedAtMs,
    retryAfterMs: retryAfterMs(input.error),
    retryPolicy: input.descriptor.retryPolicy,
  });
  input.attemptMeta[RETRY_STATE_META_KEY] = retryState;
  return retryState;
}
