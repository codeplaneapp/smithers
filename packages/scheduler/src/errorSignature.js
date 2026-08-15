import { toSmithersError } from "@smthrs/errors/toSmithersError";

/**
 * Default number of consecutive failures with an identical error signature
 * after which a task is marked `stalled` instead of being retried again
 * (#1500). Override per task with `retryPolicy.maxIdenticalFailures`.
 */
export const DEFAULT_MAX_IDENTICAL_FAILURES = 3;

const MAX_SIGNATURE_LENGTH = 320;

/**
 * Normalize the volatile parts of an error message so two failures that are
 * "the same failure" produce the same signature: absolute paths (run/tmp
 * dirs), UUIDs and long hex ids, and bare numbers (byte counts, ports,
 * sizes) are each replaced with a fixed placeholder. The transform is
 * deliberately simple and deterministic: it never looks at the environment,
 * only at the string.
 * @param {string} message
 * @returns {string}
 */
export function normalizeErrorMessage(message) {
  return message
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<id>")
    .replace(/\/[^\s'")\]}]+/g, "<path>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d[\d,]*(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the message text of an unknown failure payload without pulling in
 * the docs-URL suffix SmithersError appends to `.message`. toSmithersError
 * summarizes non-Error plain objects as "[object Object]", so a payload with
 * its own string `message` wins over that opaque summary.
 * @param {unknown} error
 * @returns {{ code: string; message: string }}
 */
function errorParts(error) {
  const payloadCode =
    error && typeof error === "object" && typeof (/** @type {{ code?: unknown }} */ (error).code) === "string"
      ? /** @type {{ code: string }} */ (error).code
      : undefined;
  const normalized = toSmithersError(error);
  const code = payloadCode ?? normalized.code ?? "ERROR";
  const payloadMessage =
    error && typeof error === "object" && typeof (/** @type {{ message?: unknown }} */ (error).message) === "string"
      ? /** @type {{ message: string }} */ (error).message
      : undefined;
  const summary = normalized.summary;
  const message =
    (summary && summary !== String(error) ? summary : undefined) ??
    payloadMessage ??
    normalized.message ??
    String(error);
  return { code, message };
}

/**
 * Compute a stable signature for a failure payload. Two attempts of the same
 * node that fail for the same reason produce the same signature even when
 * run ids, temp paths, or byte counts differ.
 * @param {unknown} error
 * @returns {string}
 */
export function computeErrorSignature(error) {
  const { code, message } = errorParts(error);
  const signature = `${code}:${normalizeErrorMessage(message)}`;
  return signature.length > MAX_SIGNATURE_LENGTH ? signature.slice(0, MAX_SIGNATURE_LENGTH) : signature;
}

/**
 * Resolve the stall threshold for a retry policy: how many consecutive
 * identical failures mark the task `stalled`. Defaults to
 * DEFAULT_MAX_IDENTICAL_FAILURES; a value <= 0 (or Infinity) disables stall
 * detection for the task.
 * @param {{ maxIdenticalFailures?: number } | undefined} retryPolicy
 * @returns {number}
 */
export function resolveMaxIdenticalFailures(retryPolicy) {
  const value = retryPolicy?.maxIdenticalFailures;
  if (value == null) return DEFAULT_MAX_IDENTICAL_FAILURES;
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_MAX_IDENTICAL_FAILURES;
  if (!Number.isFinite(value) || value <= 0) return Infinity;
  return Math.max(1, Math.floor(value));
}

/**
 * Read the identical-failure streak the engine stamped onto a failure
 * payload's details before persisting the attempt. The stamp lets stall
 * detection survive a run resume: the streak is recomputed from durable
 * attempt rows on every failure, so the in-memory session does not need its
 * own history.
 * @param {unknown} error
 * @returns {number | undefined}
 */
export function readIdenticalFailureStreak(error) {
  const details =
    error &&
    typeof error === "object" &&
    /** @type {{ details?: unknown }} */ (error).details &&
    typeof (/** @type {{ details?: unknown }} */ (error).details) === "object"
      ? /** @type {{ identicalFailureStreak?: unknown }} */ (/** @type {{ details: object }} */ (error).details)
      : undefined;
  const streak = details?.identicalFailureStreak;
  return typeof streak === "number" && Number.isSafeInteger(streak) && streak >= 1 ? streak : undefined;
}
