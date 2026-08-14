/** Broken-session failures on one engine before the run stops re-probing it. */
const DEFAULT_SESSION_BREAK_THRESHOLD = 2;

/**
 * @param {string | null | undefined} json
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(json) {
  if (typeof json !== "string" || json.length === 0) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown> | null} errorJson
 * @returns {{ quota: boolean; quotaResetAtMs: number | null; sessionLost: boolean }}
 */
function classifyFailure(errorJson) {
  if (!errorJson) return { quota: false, quotaResetAtMs: null, sessionLost: false };
  const details = /** @type {Record<string, unknown> | undefined} */ (
    errorJson.details && typeof errorJson.details === "object" ? errorJson.details : undefined
  );
  const quota = errorJson.code === "AGENT_QUOTA_EXCEEDED" || details?.failureQuota === true;
  const reset = details?.quotaResetAtMs;
  return {
    quota,
    quotaResetAtMs: typeof reset === "number" && Number.isFinite(reset) ? reset : null,
    sessionLost: errorJson.code === "AGENT_SESSION_LOST",
  };
}

/**
 * Agent ids that are terminal for the REST OF THIS RUN, derived from the run's
 * durable attempt rows.
 *
 * `agent={[a, b, c]}` is documented as a run-wide breaker: an agent that dies
 * is skipped by later selections rather than re-probed. The per-node quota
 * round and retry rung cannot deliver that, because both read only the current
 * node's attempts and key on chain index. So an engine that exhausted its
 * provider quota during `implement` was probed again by `review`, and every
 * such re-probe cost a wall-clock stall and an attempt.
 *
 * Two classifications are terminal:
 *
 * - Provider quota exhausted. Terminal until the reset time the provider
 *   named. An attempt that reported `quotaResetAtMs` stops disabling its agent
 *   once that time passes, so the existing park-and-resume path still returns
 *   to the head of the chain when the window reopens. An attempt with no
 *   reported reset time disables its agent for the remainder of the run.
 * - Repeated broken sessions. One `AGENT_SESSION_LOST` is a transient CLI
 *   fault the next attempt recovers from with a fresh session. At
 *   `sessionBreakThreshold` occurrences the CLI is failing to establish
 *   sessions at all and further attempts on it cannot succeed.
 *
 * Read-only and pure. Attempts with no recorded agent id, and every
 * non-failed attempt, are ignored.
 *
 * @param {ReadonlyArray<{ state?: string; metaJson?: string | null; errorJson?: string | null }>} runAttempts
 *   every attempt row of the run, across all nodes
 * @param {{ nowMs?: number; sessionBreakThreshold?: number }} [options]
 * @returns {Set<string>} agent ids (see `agentIdentityLabel`) to skip
 */
export function runWideDeadAgentIds(runAttempts, options = {}) {
  const now = options.nowMs ?? Date.now();
  const sessionBreakThreshold = options.sessionBreakThreshold ?? DEFAULT_SESSION_BREAK_THRESHOLD;
  /** @type {Set<string>} */
  const dead = new Set();
  /** @type {Map<string, number>} */
  const sessionBreaks = new Map();
  for (const attempt of Array.isArray(runAttempts) ? runAttempts : []) {
    if (!attempt || attempt.state !== "failed") continue;
    const agentId = parseJsonObject(attempt.metaJson)?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    const failure = classifyFailure(parseJsonObject(attempt.errorJson));
    if (failure.quota && (failure.quotaResetAtMs == null || now < failure.quotaResetAtMs)) {
      dead.add(agentId);
      continue;
    }
    if (failure.sessionLost) {
      const count = (sessionBreaks.get(agentId) ?? 0) + 1;
      sessionBreaks.set(agentId, count);
      if (count >= sessionBreakThreshold) dead.add(agentId);
    }
  }
  return dead;
}
