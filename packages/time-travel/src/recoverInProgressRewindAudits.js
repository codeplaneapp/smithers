/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * On startup, find rewind audit rows left in `in_progress` by a prior crash,
 * mark them as `partial`, and flag the associated runs as `needs_attention`.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: () => number }} [options]
 * @returns {Promise<{ recovered: Array<{ id: number; runId: string }> }>}
 */
export async function recoverInProgressRewindAudits(adapter, options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  // An adapter without a usable storage layer has no audit table to recover
  // from; treat it as a silent no-op so startup recovery never throws.
  const storage = adapter?.internalStorage;
  if (!storage || typeof storage.execute !== "function") {
    return { recovered: [] };
  }
  const rows = /** @type {Array<Record<string, unknown>>} */ (
    await storage.queryAll(
      `SELECT id, run_id, timestamp_ms
         FROM _smithers_time_travel_audit
        WHERE result = 'in_progress'`,
    )
  );
  if (rows.length === 0) {
    return { recovered: [] };
  }
  const now = nowMs();
  const recovered = [];
  for (const row of rows) {
    const id = Number(row.id);
    const runId = String(row.runId);
    const duration = Math.max(0, now - Number(row.timestampMs ?? now));
    await storage.execute(
      `UPDATE _smithers_time_travel_audit
          SET result = 'partial',
              duration_ms = COALESCE(duration_ms, ?)
        WHERE id = ?`,
      [duration, id],
    );
    try {
      const payload = JSON.stringify({
        code: "RewindFailed",
        needsAttention: true,
        message: `Rewind audit ${id} was in_progress at startup; marked partial.`,
        timestampMs: now,
      });
      await adapter.updateRun(runId, {
        status: "needs_attention",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: payload,
      });
    } catch {
      try {
        await adapter.updateRun(runId, {
          status: "failed",
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          errorJson: JSON.stringify({
            code: "RewindFailed",
            needsAttention: true,
            message: "Rewind was in_progress at startup.",
            timestampMs: now,
          }),
        });
      } catch {
        // best-effort: nothing to do if the run row was deleted.
      }
    }
    recovered.push({ id, runId });
  }
  return { recovered };
}
