/**
 * The durable `TimeTravelStore`, backed by SQL.
 *
 * Three tables carry what the journal cannot: `flows_time_travel_audits`
 * (one row per rewind, so a crash leaves something recovery can find),
 * `flows_time_travel_receipts` (proof a side effect was compensated), and
 * `flows_time_travel_snapshots` (the tier-2 anchors at a frame). Lineage edges
 * are read as ONE tree across this package's fork edges and the engine's child
 * spawns, per `docs/specs/Concepts/Subflows.md` §129-131.
 *
 * The derived reads — state and attempts at a frame — are folds over journal
 * records rather than columns, because the run row holds only the *latest*
 * state. The store is SQLite-dialect only: the schema's CHECK constraints use
 * `typeof()` and `json_valid`, the reads use `json_extract` with `$` paths,
 * and the archive writes use `INSERT OR IGNORE`, none of which Postgres or
 * MySQL parse. Any SQLite-speaking `SqlClient` (wa-sqlite, libsql, node or
 * bun SQLite) runs it; a genuinely generic dialect would have to abstract the
 * JSON functions and the constraint syntax, which is a redesign, not an edit.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { forkCreatedEventType, type LineageEdge } from "./Frame.ts"
import { error, TimeTravelError } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/**
 * Recognizes the one ALTER TABLE failure {@link migrate} may absorb: the
 * column already exists. SQLite reports it as `duplicate column name`,
 * Postgres as `column ... already exists`; the failure's message chain is
 * walked because the SQL layer wraps the driver error.
 */
const isDuplicateColumn = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = (current as { readonly message?: unknown }).message
    if (typeof message === "string" && /duplicate column|already exists/i.test(message)) return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

/**
 * Creates the time-travel tables. The DDL is SQLite dialect — `typeof()` and
 * `json_valid` CHECK constraints, a `json_extract` expression index — so it
 * runs on any SQLite-speaking `SqlClient` and nowhere else (see the module
 * header).
 *
 * @since 0.1.0
 * @category migrations
 */
export const migrate: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    rate_limit_json TEXT CHECK (rate_limit_json IS NULL OR json_valid(rate_limit_json)),
    detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json))
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS flows_time_travel_audits_status_idx
    ON flows_time_travel_audits (status)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    audit_id TEXT NOT NULL CHECK (length(audit_id) > 0),
    effect_id TEXT NOT NULL CHECK (length(effect_id) > 0),
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
  )`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_snapshots (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    lineage_id TEXT NOT NULL CHECK (length(lineage_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    change_id TEXT NOT NULL CHECK (length(change_id) > 0),
    plan_digest TEXT CHECK (plan_digest IS NULL OR length(plan_digest) > 0),
    PRIMARY KEY (run_id, lineage_id, seq)
  )`
  // Idempotent widening for a database migrated before the plan digest joined
  // the anchor. `ADD COLUMN` on a table that already has it is an error, not a
  // no-op, and there is nothing to repair when it fails — so exactly that one
  // failure is absorbed. Every other ALTER failure (a view squatting on the
  // table name, a locked or corrupt database) is real damage the migration
  // must surface, never swallow.
  yield* sql`ALTER TABLE flows_time_travel_snapshots ADD COLUMN plan_digest TEXT`.pipe(
    Effect.catch((cause) => isDuplicateColumn(cause) ? Effect.void : Effect.fail(cause))
  )
  // The frame address is `(lineageId, seq)`, and every engine record carries
  // its lineage in the open `meta` envelope. Indexing it out of `meta_json`
  // keeps a lineage-filtered replay from degenerating into a full run scan.
  yield* sql`CREATE INDEX IF NOT EXISTS flows_journal_events_lineage_idx
    ON flows_journal_events (run_id, json_extract(meta_json, '$.lineageId'), seq)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_edges (
    parent_run_id TEXT NOT NULL CHECK (length(parent_run_id) > 0),
    parent_seq INTEGER NOT NULL CHECK (
      typeof(parent_seq) = 'integer' AND parent_seq >= 0 AND parent_seq <= 9007199254740991
    ),
    child_run_id TEXT NOT NULL UNIQUE CHECK (length(child_run_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('child', 'fork', 'continuation')),
    attached INTEGER NOT NULL CHECK (attached IN (0, 1)),
    CHECK (parent_run_id <> child_run_id)
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS flows_time_travel_edges_parent_idx
    ON flows_time_travel_edges (parent_run_id, parent_seq)`
  yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_archive (
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0 AND seq <= 9007199254740991),
    event_id TEXT NOT NULL CHECK (length(event_id) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    source_seq INTEGER NOT NULL CHECK (
      typeof(source_seq) = 'integer' AND source_seq >= 0 AND source_seq <= 9007199254740991
    ),
    emitted_at_ms INTEGER NOT NULL CHECK (
      typeof(emitted_at_ms) = 'integer' AND emitted_at_ms >= 0 AND emitted_at_ms <= 9007199254740991
    ),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
    archived_at_ms INTEGER NOT NULL CHECK (
      typeof(archived_at_ms) = 'integer' AND archived_at_ms >= 0 AND archived_at_ms <= 9007199254740991
    ),
    PRIMARY KEY (run_id, seq)
  )`
})
const Json = Schema.fromJsonString(Schema.Unknown)
const RunStateJson = Schema.fromJsonString(RunState)
const mapError = (cause: unknown) =>
  cause instanceof TimeTravelError ? cause : error("unknown", "time-travel persistence failed", cause)
const decodeJson = (value: string | null) =>
  value === null
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Json)(value).pipe(Effect.mapError(mapError))
const encodeJson = (value: unknown) => Schema.encodeEffect(Json)(value).pipe(Effect.mapError(mapError))

const restartableStateJson = (stateJson: string) =>
  Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(
    Effect.flatMap((state) => {
      const { cancellation: _, result: __, ...restartable } = state
      return Schema.encodeEffect(RunStateJson)(restartable)
    }),
    Effect.mapError((cause) => error("unknown", "could not materialize executable fork state", cause))
  )

/** @private */
const EdgeRow = Schema.Struct({
  parent_run_id: Schema.NonEmptyString,
  parent_seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  child_run_id: Schema.NonEmptyString,
  kind: Schema.Literals(["child", "fork", "continuation"]),
  attached: Schema.Literals([0, 1])
})

/** @private */
type EdgeRow = typeof EdgeRow.Type

const decodeEdges = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(EdgeRow))(rows).pipe(Effect.mapError(mapError))

const edgeFromRow = (row: EdgeRow): LineageEdge => ({
  parentRunId: row.parent_run_id,
  parentSeq: row.parent_seq,
  childRunId: row.child_run_id,
  kind: row.kind,
  attached: row.attached === 1
})

const descendantsFrom = (
  rows: ReadonlyArray<EdgeRow>,
  runId: string,
  frame: TimeTravelStore.Snapshot["frame"]
): {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
  readonly attachedRunIds: ReadonlySet<string>
} => {
  const edges = rows.map(edgeFromRow)
  const attached: Array<LineageEdge> = []
  const detached: Array<LineageEdge> = []
  const attachedRunIds = new Set<string>()
  const queue: Array<string> = []
  const include = (edge: LineageEdge): void => {
    if (edge.attached) {
      if (attachedRunIds.has(edge.childRunId)) return
      attached.push(edge)
      attachedRunIds.add(edge.childRunId)
      queue.push(edge.childRunId)
    } else {
      detached.push(edge)
    }
  }
  for (const edge of edges) {
    if (edge.parentRunId === runId && edge.parentSeq > frame.seq) include(edge)
  }
  while (queue.length > 0) {
    const parentRunId = queue.shift()!
    for (const edge of edges) {
      if (edge.parentRunId === parentRunId) include(edge)
    }
  }
  return { attached, detached, attachedRunIds }
}

/**
 * The kind an engine child spawn is journaled under.
 *
 * `@smthrs/engine-store` writes a boundary-shaped record naming the child at
 * the parent's spawn seq. Reading it here is the BRIDGE decision: rather than
 * teach the engine to write `flows_time_travel_edges` (it must not depend on
 * this package) or leave three parallel stores of the same tree, fork edges
 * stay in `flows_time_travel_edges` and child edges are DERIVED from the
 * parent's own journal, which is the only one of the three that carries the
 * `parentSeq` a frame needs. `flows_runs.parent_run_id` and
 * `flows_run_parents` keep their existing jobs — the fork chain walk and cycle
 * detection — and stop being a third opinion about the lineage tree.
 *
 * @private
 */
const spawnEffectKind = "flows/engine-store/child-spawn"

/** @private */
const DecisionPayload = Schema.Struct({ state: Schema.Unknown })
const decisionState = Schema.decodeUnknownOption(DecisionPayload)

/** @private */
const AttemptPayload = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
const attemptRef = Schema.decodeUnknownOption(AttemptPayload)

/**
 * Builds the SQL-backed store, running {@link migrate} first so a fresh
 * database is usable without a separate setup step. The `SqlClient`
 * requirement is a SQLite dialect requirement, not a portable one — see the
 * module header.
 *
 * Writes go through `DurableWriter` rather than straight to `SqlClient`, so a
 * rewind's audit row, receipts, and truncation land under the same durability
 * discipline as the engine's own journal writes.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<TimeTravelStore.Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(
  function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter

    yield* migrate.pipe(Effect.mapError(() => undefined), Effect.orDie)

    /**
     * Every lineage edge, forks and engine child spawns as ONE tree.
     *
     * `docs/specs/Concepts/Subflows.md` §129-131 asks for one lineage tree with
     * an edge kind; this is that union, expressed where both sources can be
     * read. Fork edges stay in `flows_time_travel_edges`; child edges are
     * DERIVED from the parent's own journal, which is the only one of the three
     * stores of this tree that carries the `parentSeq` a frame needs.
     */
    const allEdges = sql<EdgeRow>`
      SELECT parent_run_id, parent_seq, child_run_id, kind, attached
      FROM flows_time_travel_edges
      UNION ALL
      SELECT run_id AS parent_run_id,
             seq AS parent_seq,
             json_extract(payload_json, '$.effect.output.childRunId') AS child_run_id,
             'child' AS kind,
             CASE WHEN json_extract(payload_json, '$.effect.output.attached') = 1 THEN 1 ELSE 0 END AS attached
      FROM flows_journal_events
      WHERE event_type = 'flows.time-travel.effect-boundary'
        AND json_extract(payload_json, '$.effect.kind') = ${spawnEffectKind}
        AND json_extract(payload_json, '$.effect.status') = 'succeeded'
        AND json_extract(payload_json, '$.effect.output.childRunId') IS NOT NULL
    `.pipe(Effect.flatMap(decodeEdges), Effect.mapError(mapError))

    /**
     * Reads one event type's lineage-filtered prefix.
     *
     * An entry with no `meta.lineageId` is kept: records written before lineage
     * was minted, and records from producers outside the engine, are still
     * evidence of this run, and dropping them would silently shorten the fold.
     */
    const prefix = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"],
      eventType: string
    ) =>
      sql<{ readonly seq: number; readonly payload_json: string }>`
        SELECT seq, payload_json FROM flows_journal_events
        WHERE run_id = ${runId}
          AND seq <= ${frame.seq}
          AND event_type = ${eventType}
          AND (
            json_extract(meta_json, '$.lineageId') IS NULL
            OR json_extract(meta_json, '$.lineageId') = ${frame.lineageId}
          )
        ORDER BY seq ASC
      `.pipe(Effect.mapError(mapError))

    /**
     * Run state at a frame, rebuilt by folding the run-decision records —
     * Temporal's `mutable_state_rebuilder.ApplyEvents`, scoped to the one
     * decision channel that carries state. The base comes from the `created`
     * decision (the only record naming `flowName` and `payload`) and each later
     * transition replaces it wholesale, so the fold is "last state at or before
     * the frame".
     */
    const stateAtFrame = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"]
    ): Effect.Effect<string | undefined, TimeTravelError> =>
      prefix(runId, frame, "flows.engine.run-decision").pipe(
        Effect.flatMap((rows) =>
          Effect.gen(function*() {
            let state: unknown = undefined
            for (const row of rows) {
              const payload = yield* decodeJson(row.payload_json)
              const decoded = decisionState(payload)
              if (decoded._tag === "Some") state = decoded.value.state
            }
            return state === undefined ? undefined : yield* encodeJson(state)
          })
        )
      )

    /**
     * The attempts admitted at a frame. `attempt-started` adds one and nothing
     * removes it: a failed attempt is still part of the history the child
     * inherits, and the fork replays its recorded failure rather than re-running
     * the body.
     */
    const attemptsAtFrame = (
      runId: string,
      frame: TimeTravelStore.Snapshot["frame"]
    ): Effect.Effect<ReadonlyArray<TimeTravelStore.AttemptRef>, TimeTravelError> =>
      prefix(runId, frame, "flows.engine.attempt-started").pipe(
        Effect.flatMap((rows) =>
          Effect.gen(function*() {
            const refs = new Map<string, TimeTravelStore.AttemptRef>()
            for (const row of rows) {
              const payload = yield* decodeJson(row.payload_json)
              const decoded = attemptRef(payload)
              if (decoded._tag === "None") continue
              refs.set(`${decoded.value.stepKeyDigest}:${decoded.value.attempt}`, decoded.value)
            }
            return [...refs.values()]
          })
        )
      )

    return TimeTravelStore.make({
      snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          sql<
            { readonly change_id: string; readonly seq: number; readonly plan_digest: string | null }
          >`SELECT change_id, seq, plan_digest FROM flows_time_travel_snapshots WHERE run_id = ${runId} AND lineage_id = ${frame.lineageId} AND seq <= ${frame.seq} ORDER BY seq DESC LIMIT 1`
            .pipe(
              Effect.map((rows) =>
                rows[0] === undefined ? undefined : {
                  runId,
                  frame: { lineageId: frame.lineageId, seq: rows[0].seq },
                  changeId: rows[0].change_id,
                  ...(rows[0].plan_digest === null ? {} : { planDigest: rows[0].plan_digest })
                }
              ),
              Effect.mapError(mapError)
            )
        ))
      ),
      recordSnapshot: Effect.fn("TimeTravelStore.recordSnapshot")((snapshot) =>
        Effect.annotateCurrentSpan({
          runId: snapshot.runId,
          lineageId: snapshot.frame.lineageId,
          seq: snapshot.frame.seq
        }).pipe(Effect.andThen(
          writer.write(
            sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id, plan_digest)
            VALUES (
              ${snapshot.runId},
              ${snapshot.frame.lineageId},
              ${snapshot.frame.seq},
              ${snapshot.changeId},
              ${snapshot.planDigest ?? null}
            )
            ON CONFLICT (run_id, lineage_id, seq) DO UPDATE SET
              change_id = excluded.change_id,
              plan_digest = excluded.plan_digest
          `
          ).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      ),
      stateAt: Effect.fn("TimeTravelStore.stateAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
          Effect.andThen(stateAtFrame(runId, frame))
        )
      ),
      attemptsAt: Effect.fn("TimeTravelStore.attemptsAt")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
          Effect.andThen(attemptsAtFrame(runId, frame))
        )
      ),
      descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          allEdges.pipe(
            Effect.map((rows) => {
              const descendants = descendantsFrom(rows, runId, frame)
              return { attached: descendants.attached, detached: descendants.detached }
            }),
            Effect.mapError(mapError)
          )
        ))
      ),
      writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
        Effect.annotateCurrentSpan({
          auditId: audit.id,
          runId: audit.runId,
          lineageId: audit.frame.lineageId,
          seq: audit.frame.seq
        }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const rateLimit = audit.rateLimit === undefined ? null : yield* encodeJson(audit.rateLimit)
              const detail = audit.detail === undefined ? null : yield* encodeJson(audit.detail)
              yield* sql`INSERT INTO flows_time_travel_audits (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json) VALUES (${audit.id}, ${audit.runId}, ${audit.frame.lineageId}, ${audit.frame.seq}, ${audit.status}, ${rateLimit}, ${detail})`
            })
          ).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      ),
      updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
        Effect.annotateCurrentSpan({ auditId: id }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const rows = yield* sql<
                {
                  readonly id: string
                  readonly run_id: string
                  readonly lineage_id: string
                  readonly seq: number
                  readonly status: TimeTravelStore.Audit["status"]
                  readonly rate_limit_json: string | null
                  readonly detail_json: string | null
                }
              >`SELECT * FROM flows_time_travel_audits WHERE id = ${id}`
              if (rows[0] === undefined) return yield* Effect.fail(error("not_found", `audit ${id} was not found`))
              const row = rows[0]
              const rateLimit = yield* decodeJson(row.rate_limit_json)
              const detail = yield* decodeJson(row.detail_json)
              const audit = {
                id: row.id,
                runId: row.run_id,
                frame: { lineageId: row.lineage_id, seq: row.seq },
                status: row.status,
                rateLimit,
                detail
              }
              const next = { ...audit, ...patch }
              const rateLimitJson = next.rateLimit === undefined ? null : yield* encodeJson(next.rateLimit)
              const detailJson = next.detail === undefined ? null : yield* encodeJson(next.detail)
              yield* sql`UPDATE flows_time_travel_audits SET status = ${next.status}, rate_limit_json = ${rateLimitJson}, detail_json = ${detailJson} WHERE id = ${id}`
            }).pipe(Effect.mapError(mapError))
          ).pipe(Effect.mapError(mapError), Effect.asVoid)
        ))
      ),
      pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
        sql<
          {
            readonly id: string
            readonly run_id: string
            readonly lineage_id: string
            readonly seq: number
            readonly status: "in_progress"
            readonly rate_limit_json: string | null
            readonly detail_json: string | null
          }
        >`SELECT * FROM flows_time_travel_audits WHERE status = 'in_progress'`.pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.gen(function*() {
                const rateLimit = yield* decodeJson(row.rate_limit_json)
                const detail = yield* decodeJson(row.detail_json)
                return {
                  id: row.id,
                  runId: row.run_id,
                  frame: { lineageId: row.lineage_id, seq: row.seq },
                  status: row.status,
                  rateLimit,
                  detail
                }
              }))
          ),
          Effect.mapError(mapError)
        )
      ),
      archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")((runId, frame, receipts, owner) =>
        Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              // The commit-time owner predicate: the whole archive+truncate
              // only commits while `flows_runs` still records this owner, so
              // a superseded rewinder can never truncate history behind the
              // live owner — the same fence the journal's `emitDurable`
              // asserts, one store up.
              const fence = yield* sql<{ readonly ok: number }>`
            SELECT 1 AS ok FROM flows_runs
            WHERE run_id = ${runId}
              AND owner_host_id = ${owner.hostId}
              AND owner_pid = ${owner.pid}
              AND owner_nonce = ${owner.nonce}
          `
              if (fence.length === 0) {
                return yield* Effect.fail(
                  error(
                    "fence_lost",
                    `run ${runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`
                  )
                )
              }
              const rows = yield* allEdges
              const descendants = descendantsFrom(rows, runId, frame)
              const nowMs = yield* Clock.currentTimeMillis
              const parentCount = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
              let archived = Number(parentCount[0]!.count)
              yield* sql`
            INSERT OR IGNORE INTO flows_time_travel_archive
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json, ${nowMs}
            FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
              yield* sql`
            DELETE FROM flows_journal_events
            WHERE run_id = ${runId} AND seq > ${frame.seq}
          `
              for (const childRunId of descendants.attachedRunIds) {
                const count = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_journal_events
              WHERE run_id = ${childRunId}
            `
                archived += Number(count[0]!.count)
                yield* sql`
              INSERT OR IGNORE INTO flows_time_travel_archive
              SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                     event_type, payload_json, meta_json, ${nowMs}
              FROM flows_journal_events WHERE run_id = ${childRunId}
            `
                yield* sql`DELETE FROM flows_journal_events WHERE run_id = ${childRunId}`
              }
              for (const edge of descendants.attached) {
                yield* sql`DELETE FROM flows_time_travel_edges WHERE child_run_id = ${edge.childRunId}`
              }
              for (const receipt of receipts) {
                const receiptJson = yield* encodeJson(receipt.receipt)
                yield* sql`
              INSERT INTO flows_time_travel_receipts
                (id, audit_id, effect_id, receipt_json)
              VALUES (
                ${receipt.id},
                ${receipt.auditId},
                ${receipt.effectId},
                ${receiptJson}
              )
            `
              }
              return { archived, orphaned: descendants.detached }
            }).pipe(Effect.mapError(mapError))
          ).pipe(Effect.mapError(mapError))
        ))
      ),
      archivedAt: Effect.fn("TimeTravelStore.archivedAt")((runId, seq) =>
        Effect.annotateCurrentSpan({ runId, seq }).pipe(Effect.andThen(
          sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_time_travel_archive
            WHERE run_id = ${runId} AND seq = ${seq}
          `.pipe(
            Effect.map((rows) => Number(rows[0]!.count) > 0),
            Effect.mapError(mapError)
          )
        ))
      ),
      createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame) =>
        Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              let currentRunId: string | undefined = parentRunId
              const seen = new Set<string>()
              while (currentRunId !== undefined && !seen.has(currentRunId)) {
                seen.add(currentRunId)
                const current = yield* sql<{
                  readonly status: string
                  readonly owner_host_id: string | null
                  readonly claim_host_id: string | null
                }>`
              SELECT status, owner_host_id, claim_host_id
              FROM flows_runs WHERE run_id = ${currentRunId}
            `
                if (current[0] === undefined) {
                  return yield* Effect.fail(error("not_found", `parent ${currentRunId} was not found`))
                }
                if (
                  current[0].status === "running" ||
                  current[0].owner_host_id !== null ||
                  current[0].claim_host_id !== null
                ) {
                  return yield* Effect.fail(error("live_parent", `parent ${currentRunId} is live`))
                }
                const parentEdges: ReadonlyArray<{ readonly parent_run_id: string }> = yield* sql<{
                  readonly parent_run_id: string
                }>`
              SELECT parent_run_id FROM flows_time_travel_edges
              WHERE child_run_id = ${currentRunId}
            `
                currentRunId = parentEdges[0]?.parent_run_id
              }
              const existing = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM flows_time_travel_edges
            WHERE parent_run_id = ${parentRunId} AND parent_seq = ${frame.seq}
          `
              const runId = `${parentRunId}:fork:${frame.seq}:${Number(existing[0]!.count) + 1}`
              const nowMs = yield* Clock.currentTimeMillis
              /**
               * THE CHILD'S STATE IS THE STATE **AT** THE FRAME.
               *
               * Copying `flows_runs.state_json` copied the parent's state NOW —
               * a fork at seq 3 of a run that later reached seq 40 started from
               * seq 40's payload and parent pointer. `stateAt` folds the
               * run-decision records up to the frame instead, exactly the
               * derive-don't-copy rule `ndc/state_rebuilder.go` follows. The
               * run row stays the fallback for a journal written before
               * decisions carried state; both then pass through
               * `restartableStateJson`, because a fork must not inherit the
               * parent's recorded result or cancellation.
               */
              const derived = yield* stateAtFrame(parentRunId, frame)
              // The liveness walk above already proved the parent row exists, so
              // the fallback read cannot come back empty.
              const parentState = yield* sql<{ readonly state_json: string }>`
            SELECT state_json FROM flows_runs WHERE run_id = ${parentRunId}
          `
              const stateJson = yield* restartableStateJson(derived ?? parentState[0]!.state_json)
              yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
            VALUES (${runId}, 'pending', ${nowMs}, ${parentRunId}, ${stateJson})
          `
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            SELECT ${runId}, seq, ${`fork:${runId}:`} || event_id,
                   source_id, source_seq, emitted_at_ms,
                   event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${parentRunId} AND seq <= ${frame.seq}
          `
              /**
               * THE ATTEMPTS ARE FILTERED TO THE FRAME.
               *
               * The copy had no predicate at all: a fork at seq 3 inherited every
               * attempt row the parent ever wrote, including the ones its own
               * copied journal has no record of, so the child replayed results
               * from a future it was forked away from. The `attempt-started`
               * fold names exactly the rows the copied prefix can explain.
               */
              const attempts = yield* attemptsAtFrame(parentRunId, frame)
              for (const ref of attempts) {
                yield* sql`
              INSERT INTO flows_attempts (
                run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
                heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
              )
              SELECT
                ${runId}, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
                heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
              FROM flows_attempts
              WHERE run_id = ${parentRunId}
                AND step_key_digest = ${ref.stepKeyDigest}
                AND attempt = ${ref.attempt}
            `
              }
              /**
               * THE FRAME'S ANCHORS CROSS THE FORK WITH IT.
               *
               * The anchor table is a projection of the parent's
               * `snapshot-identified` records, and the copied prefix carries
               * those records — but a fresh engine incarnation that forks the
               * CHILD next never projects the child's journal first. Copying
               * the rows at or below the frame makes the child's history
               * self-contained on restart, exactly as its copied journal and
               * attempts already are; a later projection of the child upserts
               * the same `(runId, lineageId, seq)` rows and changes nothing.
               */
              yield* sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id, plan_digest)
            SELECT ${runId}, lineage_id, seq, change_id, plan_digest
            FROM flows_time_travel_snapshots
            WHERE run_id = ${parentRunId} AND seq <= ${frame.seq}
          `
              yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${frame.seq}, ${runId}, 'fork', 0)
          `
              /**
               * The fork-created marker `docs/specs/Concepts/Forensics.md` §68
               * asks for: written on the CHILD, above the copied prefix, naming
               * the parent and the offset it was cut at. A cross-fork timeline
               * can now start from any child and find its origin without
               * consulting the edge table.
               *
               * `source_seq` is the marker's own seq, never a constant: the
               * copy above preserves source identities, so a fork-of-fork
               * whose prefix reaches the parent's own marker inherits a row
               * with this same `source_id`. Every marker keeps
               * `source_seq = seq`, and the new marker sits strictly above
               * everything it copied, so `UNIQUE (run_id, source_id,
               * source_seq)` can never collide.
               */
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES (
              ${runId},
              ${frame.seq + 1},
              ${`fork:${runId}:created`},
              ${"flows/time-travel/fork"},
              ${frame.seq + 1},
              ${nowMs},
              ${forkCreatedEventType},
              ${JSON.stringify({ parentRunId, forkJournalOffset: frame.seq, childRunId: runId })},
              ${JSON.stringify({ lineageId: frame.lineageId })}
            )
          `
              return {
                runId,
                edge: {
                  parentRunId,
                  parentSeq: frame.seq,
                  childRunId: runId,
                  kind: "fork" as const,
                  attached: false
                },
                warnings: []
              }
            }).pipe(Effect.mapError(mapError))
          ).pipe(Effect.mapError(mapError))
        ))
      ),
      recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
        Effect.annotateCurrentSpan({
          receiptId: receipt.id,
          auditId: receipt.auditId,
          effectId: receipt.effectId
        }).pipe(Effect.andThen(
          writer.write(
            Effect.gen(function*() {
              const receiptJson = yield* encodeJson(receipt.receipt)
              yield* sql`INSERT INTO flows_time_travel_receipts (id, audit_id, effect_id, receipt_json) VALUES (${receipt.id}, ${receipt.auditId}, ${receipt.effectId}, ${receiptJson})`
            })
          ).pipe(Effect.asVoid, Effect.mapError(mapError))
        ))
      )
    })
  }
)
/**
 * Provides {@link make} as the `TimeTravelStore` service. Requires a
 * `SqlClient` and a `DurableWriter`; building it migrates the schema.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<TimeTravelStore.TimeTravelStore, never, DurableWriter | SqlClient.SqlClient> = Layer
  .effect(
    TimeTravelStore.TimeTravelStore
  )(make)
