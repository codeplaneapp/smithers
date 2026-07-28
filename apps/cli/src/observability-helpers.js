/** Lifecycle events shown by `smithers events` unless raw history is requested. */
export const DEFAULT_LIFECYCLE_EVENT_TYPES = [
  "RunStarted",
  "RunStatusChanged",
  "RunStateChanged",
  "RunFinished",
  "RunFailed",
  "RunCancelled",
  "RunContinuedAsNew",
  "RunHijackRequested",
  "RunHijacked",
  "OneshotSteerQueued",
  "OneshotSteerDelivered",
  "OneshotSteerAcknowledged",
  "OneshotSteerFailed",
  "OneshotRestartRequested",
  "OneshotRestartLaunched",
  "OneshotRestartFailed",
  "RunAutoResumed",
  "RunAutoResumeSkipped",
  "RunForked",
  "NodePending",
  "NodeStarted",
  "NodeFinished",
  "NodeFailed",
  "NodeCancelled",
  "NodeSkipped",
  "NodeRetrying",
  "NodeWaitingApproval",
  "NodeWaitingTimer",
  "ApprovalRequested",
  "ApprovalGranted",
  "ApprovalAutoApproved",
  "ApprovalDenied",
];

/**
 * @param {Array<{ metaJson?: string | null }>} attempts
 */
export function tallyAttemptPool(attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    if (!attempt.metaJson) continue;
    try {
      const meta = JSON.parse(attempt.metaJson);
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
      const engine = typeof meta.agentEngine === "string" && meta.agentEngine.trim() ? meta.agentEngine.trim() : null;
      const model = typeof meta.agentModel === "string" && meta.agentModel.trim() ? meta.agentModel.trim() : null;
      if (!engine && !model) continue;
      const key = `${engine ?? "unknown"}/${model ?? "unknown"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // Old or partially-written attempt metadata is not fatal to inspect.
    }
  }
  return [...counts.entries()]
    .map(([pool, attempts]) => ({ pool, attempts }))
    .sort((a, b) => b.attempts - a.attempts || a.pool.localeCompare(b.pool));
}

/** @param {ReturnType<typeof tallyAttemptPool>} tally */
export function renderAttemptPool(tally) {
  return tally.map((entry) => `${entry.pool} x${entry.attempts}`).join(", ");
}
