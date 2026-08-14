import { REWIND_LEASE_TTL_MS } from "./acquireRewindLock.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

// A healthy rewind renews every third of its lease TTL. Waiting for five full
// lease windows gives an active process ample renewal and clock-skew margin
// before startup recovery treats its audit as abandoned.
const DEFAULT_STALE_AFTER_MS = REWIND_LEASE_TTL_MS * 5;

/**
 * Keep recovery claims and run mutations on the adapter's serialized,
 * retrying write path.
 *
 * @template T
 * @param {SmithersDb} adapter
 * @param {string} label
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function runWrite(adapter, label, operation) {
  return await adapter.write(label, operation);
}

/**
 * Update a recovered run only while no live rewind lease exists. The lease
 * predicate is repeated here because another process can acquire a lease after
 * the audit claim and before the run mutation.
 *
 * @param {SmithersDb} adapter
 * @param {SmithersDb["internalStorage"]} storage
 * @param {string} runId
 * @param {number} now
 * @param {string} errorJson
 * @returns {Promise<boolean>}
 */
async function updateRecoveredRun(adapter, storage, runId, now, errorJson) {
  const rows = await runWrite(adapter, `recover rewind run ${runId} as failed`, () =>
    storage.queryAllRaw(
      `UPDATE _smithers_runs
          SET status = 'failed',
              heartbeat_at_ms = NULL,
              runtime_owner_id = NULL,
              error_json = ?
        WHERE run_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM _smithers_rewind_leases AS lease
             WHERE lease.run_id = _smithers_runs.run_id
               AND lease.expires_at_ms > ?
          )
      RETURNING run_id`,
      [errorJson, runId, now],
    ),
  );
  return rows.length > 0;
}

/**
 * On startup, find rewind audit rows left in `in_progress` by a prior crash,
 * mark them as `partial`, and fail the associated runs with a durable
 * `needsAttention` error payload.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: () => number; staleAfterMs?: number }} [options]
 * @returns {Promise<{ recovered: Array<{ id: number; runId: string }> }>}
 */
export async function recoverInProgressRewindAudits(adapter, options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError("staleAfterMs must be a non-negative finite number.");
  }
  // An adapter without a usable storage layer has no audit table to recover
  // from; treat it as a silent no-op so startup recovery never throws.
  const storage = adapter?.internalStorage;
  if (!storage || typeof storage.queryAll !== "function" || typeof storage.queryAllRaw !== "function") {
    return { recovered: [] };
  }
  const now = nowMs();
  const cutoff = now - staleAfterMs;
  const rows = /** @type {Array<Record<string, unknown>>} */ (
    await storage.queryAll(
      `SELECT id, run_id, timestamp_ms
         FROM _smithers_time_travel_audit AS audit
        WHERE result = 'in_progress'
          AND timestamp_ms <= ?
          AND NOT EXISTS (
            SELECT 1
              FROM _smithers_rewind_leases AS lease
             WHERE lease.run_id = audit.run_id
               AND lease.expires_at_ms > ?
          )
        ORDER BY id`,
      [cutoff, now],
    )
  );
  if (rows.length === 0) {
    return { recovered: [] };
  }
  const recovered = [];
  for (const row of rows) {
    const id = Number(row.id);
    const duration = Math.max(0, now - Number(row.timestampMs ?? now));
    const claimed = await runWrite(adapter, `claim stale rewind audit ${id}`, () =>
      storage.queryAllRaw(
        `UPDATE _smithers_time_travel_audit AS audit
          SET result = 'partial',
              duration_ms = COALESCE(duration_ms, ?)
         WHERE id = ?
           AND result = 'in_progress'
           AND timestamp_ms <= ?
           AND NOT EXISTS (
             SELECT 1
               FROM _smithers_rewind_leases AS lease
              WHERE lease.run_id = audit.run_id
                AND lease.expires_at_ms > ?
           )
      RETURNING id, run_id`,
        [duration, id, cutoff, now],
      ),
    );
    const claimedRow = claimed[0];
    if (!claimedRow) {
      continue;
    }
    const claimedId = Number(claimedRow.id);
    const runId = String(claimedRow.run_id ?? claimedRow.runId);
    try {
      await updateRecoveredRun(
        adapter,
        storage,
        runId,
        now,
        JSON.stringify({
          code: "RewindFailed",
          needsAttention: true,
          message: "Rewind was in_progress at startup.",
          timestampMs: now,
        }),
      );
    } catch {
      // Best effort: nothing to do if the run row was deleted or cannot be
      // updated. The claimed audit row remains the durable recovery record.
    }
    recovered.push({ id: claimedId, runId });
  }
  return { recovered };
}
