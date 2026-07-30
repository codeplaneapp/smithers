import { computeRetryDelayMs } from "./computeRetryDelayMs.js";

/** @typedef {import("./RetryPolicy.ts").RetryPolicy} RetryPolicy */

const DURABLE_RETRY_STATE_VERSION = 1;
const durableRetryStateSymbol = Symbol.for("smithers.scheduler.durableRetryState");

/**
 * Add a validated relative delay without rounding the resulting deadline
 * below the declared minimum. Very large safe-integer delays can produce an
 * unsafe-integer absolute timestamp; advance by one representable step when
 * floating-point addition rounded down.
 *
 * @param {number} startedAtMs
 * @param {number} delayMs
 */
export function retryDeadlineMs(startedAtMs, delayMs) {
  let deadlineMs = startedAtMs + delayMs;
  while (deadlineMs - startedAtMs < delayMs) {
    deadlineMs += Math.max(1, Math.abs(deadlineMs) * Number.EPSILON);
  }
  return deadlineMs;
}

/**
 * @param {{ failureCount: number; failedAtMs: number; retryAfterMs: number; retryPolicy?: RetryPolicy }} input
 */
export function createDurableRetryState(input) {
  const policyDelayMs = computeRetryDelayMs(input.retryPolicy, input.failureCount);
  const delayMs = Math.max(policyDelayMs, input.retryAfterMs);
  return {
    version: DURABLE_RETRY_STATE_VERSION,
    failureCount: input.failureCount,
    retryAtMs: retryDeadlineMs(input.failedAtMs, delayMs),
  };
}

/**
 * Validate the deliberately small attempt-meta wire value. Returning null is
 * useful both for old rows (which have no value) and for callers that need to
 * distinguish malformed new rows with an own-property check.
 *
 * @param {unknown} value
 * @returns {{ version: 1; failureCount: number; retryAtMs: number } | null}
 */
export function parseDurableRetryState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (candidate.version !== DURABLE_RETRY_STATE_VERSION) return null;
  if (
    typeof candidate.failureCount !== "number" ||
    !Number.isSafeInteger(candidate.failureCount) ||
    candidate.failureCount < 1
  ) {
    return null;
  }
  if (typeof candidate.retryAtMs !== "number" || !Number.isFinite(candidate.retryAtMs) || candidate.retryAtMs < 0) {
    return null;
  }
  return {
    version: DURABLE_RETRY_STATE_VERSION,
    failureCount: candidate.failureCount,
    retryAtMs: candidate.retryAtMs,
  };
}

/**
 * Carry the already-persisted retry decision from the engine's failed attempt
 * row to the in-memory scheduler without putting an internal field on the
 * public/provider error payload.
 *
 * @param {unknown} error
 * @param {unknown} state
 * @returns {unknown}
 */
export function attachDurableRetryState(error, state) {
  const parsed = parseDurableRetryState(state);
  if (!parsed || !error || (typeof error !== "object" && typeof error !== "function")) return error;
  Object.defineProperty(error, durableRetryStateSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: parsed,
  });
  return error;
}

/**
 * @param {unknown} error
 * @returns {{ version: 1; failureCount: number; retryAtMs: number } | null}
 */
export function durableRetryStateFromError(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
  return parseDurableRetryState(/** @type {Record<PropertyKey, unknown>} */ (error)[durableRetryStateSymbol]);
}
