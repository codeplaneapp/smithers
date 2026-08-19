/**
 * The one-shot migration for live runs, and the per-run catch-up that keeps it
 * true afterwards.
 *
 * A workspace that turns the flows storage path on already holds runs, events,
 * and attempts in the legacy tables. Before the journal may allocate a sequence
 * for a run, its history has to exist in `flows_journal_events`, or allocation
 * would restart at 0 and collide with the rows `_smithers_events` already
 * holds. The same is true of `flows_runs` and `flows_attempts`: an attempt row
 * references its run, and every fenced write compares against the persisted
 * owner.
 *
 * The migration is therefore expressed as one idempotent function per run,
 * `syncRunIntoFlows`, and `migrateLiveRuns` is that function applied to every
 * run that has not reached a terminal state. Running it twice writes nothing the
 * second time, so it is safe to call on every process start and safe to call
 * again from a hot path.
 *
 * Legacy history is inserted into `flows_journal_events` directly rather than
 * emitted through the journal, because a backfilled row must keep the sequence
 * `_smithers_events` recorded for it. `emitDurable` allocates `MAX(seq) + 1`
 * inside the writer's transaction and takes the maximum of that and its
 * in-process floor on every emit, so a directly inserted row is observed by the
 * next allocation instead of being overwritten by it.
 */
import { Effect } from "effect";
import { LEGACY_EVENT_SOURCE_ID, toJournalEventInput } from "./eventTranslation.js";
import { toFlowsAttempt } from "./attemptTranslation.js";
import { toFlowsOwnerId } from "./ownerIdentity.js";
import { toFlowsRunStateJson, toFlowsRunStatus } from "./runTranslation.js";
import { insertOrIgnore } from "./mirrorSql.js";
import { makeJournalEventId } from "./vendoredFlows.js";

/**
 * Statuses whose runs can no longer be written to, so they need no migration.
 * These are the terminal members of `DB_RUN_ALLOWED_STATUSES` in `adapter.js`.
 */
const TERMINAL_SMITHERS_STATUSES = ["finished", "failed", "cancelled", "continued"];

/** How many legacy event rows one catch-up statement page carries. */
const EVENT_PAGE_SIZE = 500;

/**
 * @param {any} sql
 * @param {string} runId
 * @returns {any} effect yielding the `_smithers_runs` row or undefined
 */
function readSmithersRun(sql, runId) {
  return Effect.map(
    sql.unsafe(
      `SELECT run_id, parent_run_id, workflow_name, status, created_at_ms, started_at_ms, finished_at_ms,
              heartbeat_at_ms, runtime_owner_id, cancel_requested_at_ms
       FROM _smithers_runs WHERE run_id = ? LIMIT 1`,
      [runId],
    ),
    (rows) => rows[0],
  );
}

/**
 * @param {Record<string, any>} row a `_smithers_runs` row in snake_case
 * @returns {{ status: string; owner: { hostId: string; pid: number; nonce: string } | null; heartbeatAtMs: number | null }}
 */
function flowsOwnership(row) {
  const status = toFlowsRunStatus(row.status, { runtimeOwnerId: row.runtime_owner_id });
  const owner = status === "running" ? toFlowsOwnerId(row.runtime_owner_id) : null;
  if (owner === null) return { status, owner, heartbeatAtMs: null };
  // `flows_runs` requires a heartbeat on every running row, and Smithers can
  // hold an owner without one. Such a run has no lease to protect anyway, so its
  // own start time stands in, which every staleness comparison reads as
  // maximally stale.
  const heartbeatAtMs = row.heartbeat_at_ms ?? row.started_at_ms ?? row.created_at_ms ?? 0;
  return { status, owner, heartbeatAtMs: Number(heartbeatAtMs) };
}

/**
 * Create or reconcile the `flows_runs` row for one Smithers run.
 *
 * In stage 1.1 `_smithers_runs` stays the authority on ownership: the engine
 * still claims, heartbeats, and releases through the paths this module does not
 * intercept. Reconciling here, in the same transaction as the write that
 * follows, is what lets the flows fence be evaluated against the ownership the
 * caller actually holds.
 *
 * The `_smithers_runs` row the ownership was derived from is returned with it.
 * `claimRunForResume` judges driver liveness from the Smithers columns
 * (`status`, `runtime_owner_id`, `heartbeat_at_ms`) rather than from the flows
 * triple, because that judgement lives in `runDriverLiveness.js` and reads the
 * owner id verbatim.
 *
 * @param {any} sql
 * @param {Record<string, any>} row
 * @returns {any} effect yielding the flows ownership the row now records
 */
function syncRunRow(sql, row) {
  return Effect.gen(function* () {
    const ownership = flowsOwnership(row);
    const existing = yield* Effect.map(
      sql.unsafe(
        `SELECT status, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, cancel_requested_at_ms
         FROM flows_runs WHERE run_id = ? LIMIT 1`,
        [row.run_id],
      ),
      (rows) => rows[0],
    );
    if (existing === undefined) {
      // The parent edge is a foreign key into `flows_runs`, so it is only
      // carried when the parent has been migrated too. A missing parent is a
      // lineage detail, not a durability one, and `_smithers_runs` keeps it.
      const parentPresent =
        row.parent_run_id === null || row.parent_run_id === undefined
          ? false
          : (yield* sql.unsafe(`SELECT run_id FROM flows_runs WHERE run_id = ? LIMIT 1`, [row.parent_run_id])).length >
            0;
      yield* insertOrIgnore(sql, "flows_runs", {
        runId: row.run_id,
        status: ownership.status,
        createdAtMs: row.created_at_ms ?? 0,
        startedAtMs: row.started_at_ms ?? null,
        finishedAtMs: row.finished_at_ms ?? null,
        ownerHostId: ownership.owner?.hostId ?? null,
        ownerPid: ownership.owner?.pid ?? null,
        ownerNonce: ownership.owner?.nonce ?? null,
        heartbeatAtMs: ownership.heartbeatAtMs,
        parentRunId: parentPresent ? row.parent_run_id : null,
        cancelRequestedAtMs: row.cancel_requested_at_ms ?? null,
        stateJson: toFlowsRunStateJson({ status: row.status, workflowName: row.workflow_name }),
      });
      return { ...ownership, run: row };
    }
    const drifted =
      existing.status !== ownership.status ||
      (existing.owner_host_id ?? null) !== (ownership.owner?.hostId ?? null) ||
      (existing.owner_pid ?? null) !== (ownership.owner?.pid ?? null) ||
      (existing.owner_nonce ?? null) !== (ownership.owner?.nonce ?? null) ||
      (existing.heartbeat_at_ms ?? null) !== ownership.heartbeatAtMs ||
      (existing.cancel_requested_at_ms ?? null) !== (row.cancel_requested_at_ms ?? null);
    if (drifted) {
      yield* sql.unsafe(
        `UPDATE flows_runs
         SET status = ?, owner_host_id = ?, owner_pid = ?, owner_nonce = ?, heartbeat_at_ms = ?,
             started_at_ms = ?, finished_at_ms = ?, cancel_requested_at_ms = ?
         WHERE run_id = ?`,
        [
          ownership.status,
          ownership.owner?.hostId ?? null,
          ownership.owner?.pid ?? null,
          ownership.owner?.nonce ?? null,
          ownership.heartbeatAtMs,
          row.started_at_ms ?? null,
          row.finished_at_ms ?? null,
          row.cancel_requested_at_ms ?? null,
          row.run_id,
        ],
      );
    }
    return { ...ownership, run: row };
  });
}

/**
 * Copy every `_smithers_events` row the journal is missing, keeping its
 * sequence.
 *
 * @param {any} sql
 * @param {string} runId
 * @returns {any} effect yielding how many rows were copied
 */
function syncRunEvents(sql, runId) {
  return Effect.gen(function* () {
    let copied = 0;
    for (;;) {
      const floor = yield* Effect.map(
        sql.unsafe(`SELECT COALESCE(MAX(seq), -1) AS floor FROM flows_journal_events WHERE run_id = ?`, [runId]),
        (rows) => Number(rows[0]?.floor ?? -1),
      );
      const pending = yield* sql.unsafe(
        `SELECT run_id, seq, timestamp_ms, type, payload_json
         FROM _smithers_events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
        [runId, floor, EVENT_PAGE_SIZE],
      );
      if (pending.length === 0) return copied;
      for (const row of pending) {
        const seq = Number(row.seq);
        const input = toJournalEventInput(
          {
            runId: row.run_id,
            timestampMs: Number(row.timestamp_ms),
            type: row.type,
            payloadJson: row.payload_json,
          },
          { sourceId: LEGACY_EVENT_SOURCE_ID, sourceSeq: seq },
        );
        yield* insertOrIgnore(sql, "flows_journal_events", {
          runId: input.runId,
          seq,
          eventId: makeJournalEventId(input.runId, LEGACY_EVENT_SOURCE_ID, seq),
          sourceId: LEGACY_EVENT_SOURCE_ID,
          sourceSeq: seq,
          emittedAtMs: Number(row.timestamp_ms),
          eventType: input.eventType,
          payloadJson: JSON.stringify(input.payload ?? null),
          metaJson: JSON.stringify(input.meta ?? {}),
        });
        copied += 1;
      }
      if (pending.length < EVENT_PAGE_SIZE) return copied;
    }
  });
}

/**
 * Copy the run's `_smithers_attempts` rows into `flows_attempts`.
 *
 * `INSERT OR REPLACE` rather than `OR IGNORE`: an attempt row moves through
 * states, and the legacy paths this module does not intercept — `updateAttempt`
 * writing an arbitrary column patch — keep moving it, so the copy has to be
 * able to repair drift rather than only fill a hole.
 *
 * @param {any} sql
 * @param {string} runId
 * @param {{ nodeId?: string; iteration?: number; attempt?: number }} [target]
 * @returns {any} effect yielding how many rows were copied
 */
function syncRunAttempts(sql, runId, target = {}) {
  return Effect.gen(function* () {
    const clauses = ["run_id = ?"];
    const params = [runId];
    if (target.nodeId !== undefined) {
      clauses.push("node_id = ?");
      params.push(target.nodeId);
    }
    if (target.iteration !== undefined) {
      clauses.push("iteration = ?");
      params.push(/** @type {any} */ (target.iteration));
    }
    if (target.attempt !== undefined) {
      clauses.push("attempt = ?");
      params.push(/** @type {any} */ (target.attempt));
    }
    const rows = yield* sql.unsafe(
      `SELECT * FROM _smithers_attempts WHERE ${clauses.join(" AND ")} ORDER BY node_id, iteration, attempt`,
      params,
    );
    for (const row of rows) {
      const attempt = toFlowsAttempt({
        runId: row.run_id,
        nodeId: row.node_id,
        iteration: row.iteration,
        attempt: row.attempt,
        state: row.state,
        startedAtMs: row.started_at_ms,
        finishedAtMs: row.finished_at_ms,
        heartbeatAtMs: row.heartbeat_at_ms,
        errorJson: row.error_json,
        heartbeatDataJson: row.heartbeat_data_json,
        jjPointer: row.jj_pointer,
        cached: row.cached,
        metaJson: row.meta_json,
        responseText: row.response_text,
        jjCwd: row.jj_cwd,
        effort: row.effort,
      });
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO flows_attempts
           (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms,
            checkpoint_json, error_json, outcome_json, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
        [
          attempt.runId,
          attempt.stepKeyDigest,
          attempt.attempt,
          attempt.state,
          attempt.startedAtMs,
          attempt.finishedAtMs ?? null,
          attempt.heartbeatAtMs ?? null,
          attempt.error === undefined ? null : JSON.stringify(attempt.error),
          JSON.stringify(attempt.meta ?? {}),
        ],
      );
    }
    return rows.length;
  });
}

/**
 * Bring one run's flows storage up to date with the legacy tables.
 *
 * Must run inside the caller's `Journal.transact`, so the catch-up and the write
 * it precedes commit together.
 *
 * @param {any} sql
 * @param {string} runId
 * @param {{ attempts?: boolean; attemptTarget?: { nodeId?: string; iteration?: number; attempt?: number } }} [options]
 * @returns {any} effect yielding the run's flows ownership plus the
 *   `_smithers_runs` row it came from, or `null` when the run does not exist
 */
export function syncRunIntoFlows(sql, runId, options = {}) {
  return Effect.gen(function* () {
    const row = yield* readSmithersRun(sql, runId);
    if (row === undefined) return null;
    const ownership = yield* syncRunRow(sql, row);
    yield* syncRunEvents(sql, runId);
    if (options.attempts) yield* syncRunAttempts(sql, runId, options.attemptTarget);
    return ownership;
  });
}

/**
 * Re-derive the `flows_runs` ownership columns from `_smithers_runs`, without
 * touching the journal or the attempt table.
 *
 * This is the repair half of the seam described above, isolated so a caller
 * that has just written `_smithers_runs` itself can publish that write into
 * flows without paying for another event catch-up. `claimRunForResume` uses it
 * on the operator-override path, where the legacy compare-and-set is the
 * arbiter and `flows_runs` follows it.
 *
 * @param {any} sql
 * @param {string} runId
 * @returns {any} effect yielding the flows ownership now recorded, or `null`
 *   when the run does not exist in `_smithers_runs`
 */
export function reconcileRunOwnership(sql, runId) {
  return Effect.gen(function* () {
    const row = yield* readSmithersRun(sql, runId);
    if (row === undefined) return null;
    return yield* syncRunRow(sql, row);
  });
}

/**
 * Migrate every run that is still live.
 *
 * @param {any} sql
 * @returns {any} effect yielding a per-table summary
 */
export function migrateLiveRuns(sql) {
  return Effect.gen(function* () {
    const placeholders = TERMINAL_SMITHERS_STATUSES.map(() => "?").join(", ");
    const runs = yield* sql.unsafe(
      `SELECT run_id FROM _smithers_runs WHERE LOWER(status) NOT IN (${placeholders}) ORDER BY created_at_ms ASC`,
      TERMINAL_SMITHERS_STATUSES,
    );
    let events = 0;
    let attempts = 0;
    for (const run of runs) {
      const row = yield* readSmithersRun(sql, run.run_id);
      if (row === undefined) continue;
      yield* syncRunRow(sql, row);
      events += yield* syncRunEvents(sql, run.run_id);
      attempts += yield* syncRunAttempts(sql, run.run_id);
    }
    return { runs: runs.length, events, attempts };
  });
}
