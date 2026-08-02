import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */

/**
 * Count audit rows for one caller and run in a time window.
 * Only counts terminal (non-in_progress) rows so that a live attempt
 * does not itself blow the rate-limit quota, and skips `rejected` rows so
 * that retries of a refused rewind cannot keep refreshing the window and
 * lock the caller out indefinitely.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; caller: string; sinceMs: number; }} input
 * @returns {Promise<number>}
 */
export async function countRecentRewindAuditRows(adapter, input) {
  const storage = resolveRewindAuditClient(adapter);
  const row = /** @type {Record<string, unknown> | undefined} */ (
    await storage.queryOne(
      `SELECT COUNT(*) AS count
         FROM _smithers_time_travel_audit
        WHERE run_id = ?
          AND caller = ?
          AND timestamp_ms >= ?
          AND result NOT IN ('in_progress', 'rejected')`,
      [input.runId, input.caller, input.sinceMs],
    )
  );
  return Number(row?.count ?? 0);
}
