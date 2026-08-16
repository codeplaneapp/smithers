import { toSmithersError } from "@smthrs/errors/toSmithersError";

/**
 * Failure shapes that retrying can never fix, independent of the task kind
 * (#1500). Classified BEFORE a retry is scheduled so a deterministic failure
 * goes straight to the terminal state with its full payload instead of
 * burning the retry budget.
 *
 * - `ENOENT` messages: a missing filesystem precondition. Re-running `statx`
 *   on a path that does not exist cannot succeed on a later attempt.
 * - `*_TOO_LARGE` codes: hard size-cap breaches (heartbeat payloads, tool
 *   files/contents/patches, sandbox bundles, continuation state). Regenerating
 *   the same artifact reproduces the same breach.
 *
 * Schema-validation failures (`INVALID_OUTPUT`) are deliberately NOT here:
 * agent tasks get a fresh generation on each attempt, so only compute tasks
 * treat them as terminal (see NON_RETRYABLE_COMPUTE_CODES in
 * makeWorkflowSession). An agent task that cannot satisfy its validator is
 * caught by stall detection once the failures repeat byte-identically.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTerminalFailureShape(error) {
  const payloadCode =
    error && typeof error === "object" && typeof (/** @type {{ code?: unknown }} */ (error).code) === "string"
      ? /** @type {{ code: string }} */ (error).code
      : undefined;
  const normalized = toSmithersError(error);
  const code = payloadCode ?? normalized.code;
  if (typeof code === "string" && code.endsWith("_TOO_LARGE")) {
    return true;
  }
  // toSmithersError summarizes non-Error plain objects as "[object Object]";
  // a payload carrying its own string message wins over that opaque summary.
  const payloadMessage =
    error && typeof error === "object" && typeof (/** @type {{ message?: unknown }} */ (error).message) === "string"
      ? /** @type {{ message: string }} */ (error).message
      : undefined;
  const summary = normalized.summary;
  const message =
    (summary && summary !== String(error) ? summary : undefined) ?? payloadMessage ?? normalized.message ?? "";
  if (/\bENOENT\b/.test(message)) {
    return true;
  }
  return false;
}
