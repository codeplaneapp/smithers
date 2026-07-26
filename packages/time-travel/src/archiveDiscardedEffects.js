/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./EffectBoundaryAttempt.ts").EffectBoundaryAttempt} EffectBoundaryAttempt */

const JOURNAL_COLUMNS = [
  "run_id",
  "node_id",
  "iteration",
  "attempt",
  "seq",
  "call_token",
  "tool_name",
  "input_json",
  "output_json",
  "started_at_ms",
  "finished_at_ms",
  "status",
  "error_json",
  "kind",
  "side_effect",
  "idempotent",
  "accepts_idempotency_key",
  "has_revert",
  "idempotency_key",
  "revert_status",
  "reverted_at_ms",
  "revert_error_json",
  "forced_past_json",
].join(", ");

/**
 * Move journal rows into the collision-free archive. Callers invoke this
 * inside the same transaction that discards the corresponding attempts.
 *
 * @param {SmithersDb} db
 * @param {{
 *   runId: string;
 *   opId: string;
 *   archivedAtMs: number;
 *   archiveReason: string;
 *   cutoffMs?: number;
 *   attempts?: readonly EffectBoundaryAttempt[];
 * }} params
 * @returns {Promise<number>}
 */
export async function archiveDiscardedEffects(db, params) {
  const attempts = params.attempts ?? [];
  const clauses = [];
  const values = [params.runId];
  if (attempts.length > 0) {
    for (const attempt of attempts) {
      clauses.push("(node_id = ? AND iteration = ? AND attempt = ?)");
      values.push(attempt.nodeId, attempt.iteration, attempt.attempt);
    }
  } else {
    clauses.push("started_at_ms >= ?");
    values.push(Number(params.cutoffMs ?? 0));
  }
  const predicate = clauses.join(" OR ");
  const rows = await db.internalStorage.queryAll(
    `SELECT node_id, iteration, attempt, seq FROM _smithers_tool_calls
      WHERE run_id = ? AND (${predicate})`,
    values,
  );
  if (rows.length === 0) return 0;
  await db.internalStorage.execute(
    `INSERT INTO _smithers_tool_call_archive
      (${JOURNAL_COLUMNS}, archived_by_op, archived_at_ms, archive_reason)
     SELECT ${JOURNAL_COLUMNS}, ?, ?, ?
       FROM _smithers_tool_calls
      WHERE run_id = ? AND (${predicate})`,
    [params.opId, params.archivedAtMs, params.archiveReason, ...values],
  );
  await db.internalStorage.execute(`DELETE FROM _smithers_tool_calls WHERE run_id = ? AND (${predicate})`, values);
  return rows.length;
}
