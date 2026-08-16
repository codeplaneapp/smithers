import { computeErrorSignature, isStallableFailure, resolveMaxIdenticalFailures } from "@smthrs/scheduler";

/** @param {unknown} value */
function parseJsonObject(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Quota failures park the run instead of consuming the retry budget; they
 * must not count toward a non-progress streak either.
 * @param {{ state?: string | null; errorJson?: string | null; metaJson?: string | null }} attempt
 */
function isQuotaAttempt(attempt) {
  const error = parseJsonObject(attempt.errorJson);
  if (error) {
    if (error.code === "AGENT_QUOTA_EXCEEDED") return true;
    const details = error.details;
    if (details && typeof details === "object" && details.failureQuota === true) return true;
  }
  return parseJsonObject(attempt.metaJson)?.failureQuota === true;
}

/**
 * Length of the identical-failure streak INCLUDING the current failure:
 * 1 plus the number of immediately preceding attempts (newest first) that
 * failed with the same error signature. Any non-failed or quota attempt, or
 * a different signature, ends the streak.
 *
 * Recomputed from durable attempt rows on every failure so the scheduler's
 * stall verdict (#1500) survives run resumes and owner handoffs without any
 * in-memory history.
 *
 * @param {ReadonlyArray<{ state?: string | null; errorJson?: string | null; metaJson?: string | null }>} priorAttempts newest first
 * @param {string} signature signature of the current failure (computeErrorSignature)
 * @returns {number}
 */
export function computeIdenticalFailureStreak(priorAttempts, signature) {
  let streak = 1;
  for (const attempt of priorAttempts) {
    if (attempt.state !== "failed" || isQuotaAttempt(attempt)) break;
    const error = parseJsonObject(attempt.errorJson);
    if (!error || computeErrorSignature(error) !== signature) break;
    streak += 1;
  }
  return streak;
}

/**
 * Stamp the failure payload with its error signature and identical-failure
 * streak, and mirror the scheduler's stall verdict for this attempt (#1500).
 * Every task bridge that persists a failed attempt calls this, so agent,
 * compute, and static tasks all reach the same `stalled` verdict from the
 * same durable evidence.
 *
 * The payload is mutated in place: the scheduler reads the streak back
 * (`readIdenticalFailureStreak`) to decide stalled vs retry, and the attempt
 * row keeps both fields for `smithers why` and `inspect`.
 *
 * @param {Record<string, any>} failureErrorJson errorToJson output, mutated in place
 * @param {ReadonlyArray<{ state?: string | null; errorJson?: string | null; metaJson?: string | null }>} priorAttempts newest first, excluding the current attempt's failure
 * @param {{ retries?: number; retryPolicy?: unknown; agent?: unknown }} descriptor
 * @param {{ isQuota?: boolean }} [options] quota failures park the run instead of stalling
 * @returns {{ signature: string; streak: number; stalled: boolean }}
 */
export function stampIdenticalFailureStreak(failureErrorJson, priorAttempts, descriptor, options = {}) {
  const signature = computeErrorSignature(failureErrorJson);
  const streak = computeIdenticalFailureStreak(priorAttempts, signature);
  failureErrorJson.details = {
    ...(failureErrorJson.details && typeof failureErrorJson.details === "object" ? failureErrorJson.details : {}),
    errorSignature: signature,
    identicalFailureStreak: streak,
  };
  const stalled =
    options.isQuota !== true &&
    isStallableFailure(/** @type {any} */ (descriptor), failureErrorJson) &&
    streak >= resolveMaxIdenticalFailures(/** @type {any} */ (descriptor.retryPolicy));
  return { signature, streak, stalled };
}
