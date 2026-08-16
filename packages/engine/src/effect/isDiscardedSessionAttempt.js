/**
 * A resumed agent session whose persisted id is dead fails the attempt before
 * any work is dispatched: the agent discards the id and the next attempt opens
 * a fresh session. Like a quota-limited attempt, such a failure must never
 * consume the task's retry budget — otherwise a long task whose session ids go
 * stale (the CLI pruned the conversation, the machine restarted, the id aged
 * out) exhausts its budget on session bookkeeping instead of real failures.
 *
 * A session that broke even though the attempt started FRESH is deliberately
 * excluded: retrying cannot help, so it must consume the budget and let the
 * task fail over to the next agent in the chain.
 *
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 * @returns {boolean}
 */
export function isDiscardedSessionAttempt(attempt) {
  if (!attempt) return false;
  if (attempt.errorJson) {
    try {
      const error = JSON.parse(attempt.errorJson);
      if (error?.code === "AGENT_SESSION_LOST" && isDiscardedResumeDetails(error?.details)) return true;
    } catch {
      // A malformed failure payload cannot prove the session was discarded.
    }
  }
  if (attempt.metaJson) {
    try {
      return isDiscardedResumeDetails(JSON.parse(attempt.metaJson));
    } catch {
      return false;
    }
  }
  return false;
}

/** @param {unknown} details */
function isDiscardedResumeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const typed = /** @type {{ discardResumeSession?: unknown; freshSessionFailure?: unknown }} */ (details);
  return typed.discardResumeSession === true && typed.freshSessionFailure !== true;
}
