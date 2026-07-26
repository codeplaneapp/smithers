/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Flag a run whose working copy was already rewound but whose database half
 * failed, so the inconsistent DB/filesystem state is operator-visible instead
 * of silently resuming over work that no longer exists on disk.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; timestampMs: number; reason: string; code: string }} opts
 */
export async function markRunNeedsAttention(adapter, opts) {
  const { runId, timestampMs, reason, code } = opts;
  const payload = JSON.stringify({
    code,
    needsAttention: true,
    message: reason,
    timestampMs,
  });
  try {
    await adapter.updateRun(runId, {
      status: "needs_attention",
      finishedAtMs: timestampMs,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      errorJson: payload,
    });
    return;
  } catch {
    // Older schemas may not accept needs_attention; preserve the signal in errorJson.
  }
  await adapter.updateRun(runId, {
    status: "failed",
    finishedAtMs: timestampMs,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    errorJson: payload,
  });
}
