/**
 * SQLite-backed trigger store.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import { affectedRows, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "./migrations/index.ts"
import * as Overlap from "./Overlap.ts"
import * as Schedule from "./Schedule.ts"
import * as Trigger from "./Trigger.ts"
import { fromSchemaError, TriggerError } from "./TriggerError.ts"
import {
  type Claim,
  type ClaimFire,
  type FireRecord,
  type Heartbeat,
  historyLimit,
  historyPage,
  isReservation,
  type Outcome,
  type Registered,
  reservationId,
  reservationLeaseMs,
  reservationOccurrence,
  type Service,
  TriggerStore
} from "./TriggerStore.ts"

/** @category constants @since 0.1.0 */
export { reservationLeaseMs } from "./TriggerStore.ts"

interface Row {
  readonly trigger_id: string
  readonly flow_id: string
  readonly input_json: string
  readonly cron: string
  readonly timezone: string | null
  readonly overlap: Registered["overlap"]
  readonly catch_up: Registered["catchUp"]
  readonly max_catch_up: number
  readonly enabled: number
  readonly revision: number
  readonly last_fired_at_ms: number | null
}

interface FireRow {
  readonly trigger_id: string
  readonly occurrence_at_ms: number
  readonly outcome: Outcome | null
  readonly run_id: string | null
  readonly error: string | null
}

const fireRecord = (row: FireRow): FireRecord => ({
  triggerId: row.trigger_id,
  occurrence: row.occurrence_at_ms,
  outcome: row.outcome,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.error === null ? {} : { error: row.error })
})

interface ClaimRow {
  readonly enabled: number
  readonly revision: number
  readonly overlap: Registered["overlap"]
  readonly active_run_id: string | null
  readonly active_claimed_at_ms: number | null
  readonly pending_at_ms: number | null
}

const storeError = (message: string, cause?: unknown) =>
  new TriggerError({
    code: "store",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const unknownTrigger = (triggerId: string) =>
  new TriggerError({ code: "unknown_trigger", message: `unknown trigger ${triggerId}` })

const decode = (row: Row): Effect.Effect<Registered, TriggerError> =>
  Effect.try({
    try: () => ({
      id: row.trigger_id,
      flowId: row.flow_id,
      input: JSON.parse(row.input_json) as Registered["input"],
      cron: row.cron,
      ...(row.timezone === null ? {} : { timezone: row.timezone }),
      overlap: row.overlap,
      catchUp: row.catch_up,
      maxCatchUp: row.max_catch_up,
      enabled: row.enabled === 1,
      revision: row.revision,
      ...(row.last_fired_at_ms === null ? {} : { lastFiredAt: row.last_fired_at_ms })
    }),
    catch: (cause) => storeError("could not decode trigger row", cause)
  })

/**
 * Builds a {@link TriggerStore.Service} over the ambient SQL client, with
 * every write going through the durable writer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<
  Service,
  TriggerError,
  DurableWriter | SqlClient.SqlClient
> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  // The migrator raises a schema it cannot apply as a defect, not as a typed
  // failure, so mapping the error channel alone left a defect escaping a
  // constructor whose signature promises `TriggerError`. Defects are caught
  // separately from failures, which leaves interruption alone.
  const migrationFailed = (cause: unknown) => storeError("could not run trigger migrations", cause)
  yield* Migrations.run.pipe(
    Effect.mapError(migrationFailed),
    Effect.catchDefect((defect) => Effect.fail(migrationFailed(defect)))
  )
  // A failure the store itself typed already says which refusal it is, so it
  // travels out unchanged. Re-wrapping it turned `unknown trigger x` into the
  // generic write failure and erased the one code a caller could branch on.
  const asTriggerError = (message: string) => (cause: unknown): TriggerError =>
    cause instanceof TriggerError ? cause : storeError(message, cause)
  const read = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, TriggerError> =>
    effect.pipe(Effect.mapError(asTriggerError("trigger store read failed")))
  const write = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, TriggerError> =>
    writer.write(effect).pipe(Effect.mapError(asTriggerError("trigger store write failed")))
  const requireTrigger = (triggerId: string) =>
    sql<{ readonly trigger_id: string }>`SELECT trigger_id FROM flows_triggers WHERE trigger_id = ${triggerId}`.pipe(
      Effect.flatMap((rows) => rows[0] === undefined ? Effect.fail(unknownTrigger(triggerId)) : Effect.void)
    )
  const get: Service["get"] = (triggerId) =>
    read(sql<Row>`SELECT * FROM flows_triggers WHERE trigger_id = ${triggerId}`).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(Option.none()) : decode(rows[0]).pipe(Effect.map(Option.some))
      )
    )
  const claimInTransaction = (
    fire: ClaimFire,
    claimedAt: number,
    suppliedRow?: ClaimRow
  ) =>
    Effect.gen(function*() {
      // The declaration is read first and inside the transaction, so the
      // policy applied is the stored one and a caller holding a snapshot from
      // before an edit is refused rather than obeyed.
      const row = suppliedRow ?? (yield* sql<ClaimRow>`
        SELECT enabled, revision, overlap, active_run_id, active_claimed_at_ms, pending_at_ms
        FROM flows_triggers WHERE trigger_id = ${fire.triggerId}
      `)[0]
      if (row === undefined) return yield* Effect.fail(unknownTrigger(fire.triggerId))
      if (row.revision !== fire.expectedRevision) {
        return yield* Effect.fail(
          new TriggerError({
            code: "revision_mismatch",
            message:
              `trigger ${fire.triggerId} is at revision ${row.revision}, not the claimed ${fire.expectedRevision}`
          })
        )
      }
      if (row.enabled !== 1) {
        return yield* Effect.fail(
          new TriggerError({
            code: "trigger_disabled",
            message: `trigger ${fire.triggerId} is disabled`
          })
        )
      }
      const insertResult = yield* sql`
        INSERT INTO flows_trigger_fires (trigger_id, occurrence_at_ms)
        VALUES (${fire.triggerId}, ${fire.occurrence})
        ON CONFLICT (trigger_id, occurrence_at_ms) DO NOTHING
      `.raw
      const inserted = yield* affectedRows(insertResult)
      let existingOutcome: string | null | undefined
      let existingRunId: string | null | undefined
      if (inserted === 0) {
        const existing = yield* sql<{ readonly outcome: string | null; readonly run_id: string | null }>`
          SELECT outcome, run_id FROM flows_trigger_fires
          WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}
        `
        existingOutcome = existing[0]?.outcome
        existingRunId = existing[0]?.run_id
      }
      let activeRunId = row.active_run_id ?? undefined
      let pendingAt = row.pending_at_ms ?? undefined
      const reservation = reservationId(fire.triggerId, fire.occurrence)
      // A reservation with no claim timestamp predates the lease column.
      // Nothing writes that shape now, so treating it as expired is the only
      // way such a row is ever reclaimed.
      const expiredReservation = activeRunId !== undefined && isReservation(activeRunId) &&
          (row.active_claimed_at_ms === null || row.active_claimed_at_ms <= claimedAt - reservationLeaseMs)
        ? activeRunId
        : undefined
      const reservationExpired = expiredReservation !== undefined
      if (existingOutcome !== undefined) {
        const resumableBuffer = fire.resumeBuffered === true && existingOutcome === "buffered"
        const resumableReservation = existingOutcome === null &&
          (activeRunId === undefined || (activeRunId === reservation && reservationExpired))
        const resumableSupersede = fire.resumeBuffered === true && existingOutcome === null &&
          row.overlap === "supersede" && activeRunId !== undefined && existingRunId === activeRunId
        if (!resumableBuffer && !resumableReservation && !resumableSupersede) {
          return { claimed: false as const }
        }
      }
      if (expiredReservation !== undefined) {
        const expiredOccurrence = reservationOccurrence(expiredReservation)
        if (expiredOccurrence !== undefined) {
          const expiredFires = yield* sql<{ readonly outcome: string | null; readonly run_id: string | null }>`
            SELECT outcome, run_id FROM flows_trigger_fires
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${expiredOccurrence}
          `
          const expiredFire = expiredFires[0]
          if (expiredFire !== undefined && (expiredFire.outcome === null || expiredFire.outcome === "buffered")) {
            if (row.overlap === "supersede") {
              const predecessor = expiredFire.run_id
              activeRunId = predecessor !== null && !isReservation(predecessor) ? predecessor : undefined
              if (expiredOccurrence !== fire.occurrence) {
                yield* sql`UPDATE flows_trigger_fires SET outcome = 'superseded'
                  WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${expiredOccurrence}`
              }
            } else {
              activeRunId = undefined
              if (expiredOccurrence !== fire.occurrence) {
                pendingAt = Overlap.pendingAfter({ running: false, pending: pendingAt, due: expiredOccurrence })
              }
            }
          } else {
            activeRunId = undefined
          }
        } else {
          activeRunId = undefined
        }
        yield* sql`UPDATE flows_triggers
          SET active_run_id = ${activeRunId ?? null}, active_claimed_at_ms = NULL, pending_at_ms = ${pendingAt ?? null}
          WHERE trigger_id = ${fire.triggerId} AND active_run_id = ${expiredReservation}`
      }
      const state: Overlap.State = {
        running: activeRunId !== undefined,
        pending: pendingAt,
        due: fire.occurrence
      }
      const action = Overlap.decide(row.overlap, state)
      if (action === "skip") {
        yield* sql`UPDATE flows_trigger_fires SET outcome = 'skipped'
          WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}`
        yield* sql`UPDATE flows_triggers
          SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${fire.occurrence}), ${fire.occurrence})
          WHERE trigger_id = ${fire.triggerId}`
        return { claimed: true as const, action } satisfies Claim
      }
      if (action === "buffer") {
        yield* sql`UPDATE flows_trigger_fires SET outcome = 'buffered'
          WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}`
        yield* sql`UPDATE flows_triggers
          SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${fire.occurrence}), ${fire.occurrence}),
            pending_at_ms = ${Overlap.pendingAfter(state)}
          WHERE trigger_id = ${fire.triggerId}`
        return { claimed: true as const, action } satisfies Claim
      }
      let supersededRunId = activeRunId
      if (action === "supersede" && activeRunId !== undefined) {
        if (isReservation(activeRunId)) {
          const activeOccurrence = reservationOccurrence(activeRunId)
          if (activeOccurrence !== undefined) {
            const predecessors = yield* sql<{ readonly run_id: string | null }>`
              SELECT run_id FROM flows_trigger_fires
              WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${activeOccurrence}
            `
            const predecessor = predecessors[0]?.run_id ?? undefined
            if (predecessor !== undefined && !isReservation(predecessor)) {
              supersededRunId = predecessor
              yield* sql`UPDATE flows_trigger_fires SET outcome = 'superseded'
                WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${activeOccurrence}`
            }
          }
        }
        if (supersededRunId !== undefined && !isReservation(supersededRunId)) {
          yield* sql`UPDATE flows_trigger_fires SET run_id = ${supersededRunId}
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}`
        }
      }
      yield* sql`UPDATE flows_triggers SET active_run_id = ${reservation}, active_claimed_at_ms = ${claimedAt}
        WHERE trigger_id = ${fire.triggerId}`
      return {
        claimed: true as const,
        action,
        reservationId: reservation,
        ...(supersededRunId === undefined ? {} : { activeRunId: supersededRunId })
      }
    })
  return {
    register: (trigger) => {
      const decoded = Schema.decodeUnknownResult(Trigger.Trigger)(trigger)
      if (Result.isFailure(decoded)) {
        return Effect.fail(
          fromSchemaError("invalid_trigger", "Trigger declaration is invalid", decoded.failure)
        )
      }
      const snapshot = decoded.success
      let input: string | undefined
      try {
        input = JSON.stringify(snapshot.input)
      } catch (cause) {
        return Effect.fail(storeError("trigger input is not JSON-serializable", cause))
      }
      // `JSON.stringify` answers `undefined` rather than throwing for an input
      // it cannot represent. Keep this guard even though Schema.Json currently
      // refuses every such input before serialization.
      if (input === undefined) {
        return Effect.fail(
          new TriggerError({
            code: "invalid_trigger",
            message: "trigger input has no JSON representation",
            path: "input"
          })
        )
      }
      // Registration is the last point where an unsatisfiable expression can
      // still be refused. The decoded declaration and its input string were
      // already copied at the call boundary, before this lazy work begins.
      return Effect.suspend(() =>
        Schedule.validate(snapshot).pipe(
          Effect.andThen(
            write(sql`
              INSERT INTO flows_triggers (trigger_id, flow_id, input_json, cron, timezone, overlap, catch_up, max_catch_up, enabled, revision)
              VALUES (${snapshot.id}, ${snapshot.flowId}, ${input}, ${snapshot.cron}, ${
              snapshot.timezone ?? null
            }, ${snapshot.overlap}, ${snapshot.catchUp}, ${snapshot.maxCatchUp}, ${snapshot.enabled ? 1 : 0}, 1)
              ON CONFLICT (trigger_id) DO UPDATE SET flow_id = excluded.flow_id, input_json = excluded.input_json, cron = excluded.cron,
                timezone = excluded.timezone, overlap = excluded.overlap, catch_up = excluded.catch_up, max_catch_up = excluded.max_catch_up,
                enabled = excluded.enabled, revision = flows_triggers.revision + 1
            `.pipe(
              Effect.flatMap(() => get(snapshot.id)),
              Effect.flatMap((registered) =>
                Option.isSome(registered)
                  ? Effect.succeed(registered.value)
                  : Effect.fail(storeError("registered trigger disappeared"))
              )
            ))
          )
        )
      )
    },
    get,
    list: () =>
      read(sql<Row>`SELECT * FROM flows_triggers ORDER BY trigger_id`).pipe(
        Effect.flatMap((rows) => Effect.all(rows.map(decode)))
      ),
    listEnabled: () =>
      read(sql<Row>`SELECT * FROM flows_triggers WHERE enabled = 1 ORDER BY trigger_id`).pipe(
        Effect.flatMap((rows) => Effect.all(rows.map(decode)))
      ),
    claimFire: (fire) =>
      Effect.gen(function*() {
        const claimedAt = yield* Clock.currentTimeMillis
        return yield* write(claimInTransaction(fire, claimedAt))
      }),
    claimPending: (fire) =>
      Effect.gen(function*() {
        const claimedAt = yield* Clock.currentTimeMillis
        return yield* write(Effect.gen(function*() {
          const rows = yield* sql<ClaimRow>`
            SELECT enabled, revision, overlap, active_run_id, active_claimed_at_ms, pending_at_ms
            FROM flows_triggers WHERE trigger_id = ${fire.triggerId}
          `
          const row = rows[0]
          if (row === undefined) return yield* Effect.fail(unknownTrigger(fire.triggerId))
          if (row.pending_at_ms === null) return Option.none()
          const occurrence = row.pending_at_ms
          const claim = yield* claimInTransaction(
            {
              triggerId: fire.triggerId,
              occurrence,
              expectedRevision: fire.expectedRevision,
              resumeBuffered: true
            },
            claimedAt,
            row
          )
          if (claim.claimed && claim.action !== "buffer") {
            yield* sql`UPDATE flows_triggers SET pending_at_ms = NULL WHERE trigger_id = ${fire.triggerId}`
          }
          return Option.some({ occurrence, claim })
        }))
      }),
    recordResult: (result) =>
      write(
        Effect.gen(function*() {
          yield* requireTrigger(result.triggerId)
          const terminal = result.outcome === "completed" ||
            result.outcome === "failed" ||
            result.outcome === "superseded"
          if (terminal && result.runId === undefined) {
            // Keep the recorded owner so an unqualified late result can only
            // clear the run launched by this occurrence, never a newer one.
            yield* sql`UPDATE flows_trigger_fires
              SET outcome = ${result.outcome}, error = ${result.error ?? null}
              WHERE trigger_id = ${result.triggerId} AND occurrence_at_ms = ${result.occurrence}`
          } else {
            yield* sql`UPDATE flows_trigger_fires
              SET outcome = ${result.outcome}, run_id = ${result.runId ?? null}, error = ${result.error ?? null}
              WHERE trigger_id = ${result.triggerId} AND occurrence_at_ms = ${result.occurrence}`
          }
          // `last_fired_at_ms` is the cursor catch-up resumes from, so it only
          // ever moves forward. An older run settling after a newer occurrence
          // was skipped used to drag it backwards and replay settled work.
          if (result.outcome === "launched") {
            yield* sql`UPDATE flows_triggers
              SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${result.occurrence}), ${result.occurrence}),
                active_run_id = ${result.runId ?? null},
                active_claimed_at_ms = NULL
              WHERE trigger_id = ${result.triggerId}`
            return
          }
          if (terminal) {
            let resultOwner = result.runId
            if (resultOwner === undefined) {
              const owners = yield* sql<{ readonly run_id: string | null }>`
                SELECT run_id FROM flows_trigger_fires
                WHERE trigger_id = ${result.triggerId} AND occurrence_at_ms = ${result.occurrence}
              `
              resultOwner = owners[0]?.run_id ?? reservationId(result.triggerId, result.occurrence)
            }
            yield* sql`UPDATE flows_triggers
              SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${result.occurrence}), ${result.occurrence}),
                active_run_id = CASE
                  WHEN active_run_id = ${resultOwner} THEN NULL
                  ELSE active_run_id
                END,
                active_claimed_at_ms = CASE
                  WHEN active_run_id = ${resultOwner} THEN NULL
                  ELSE active_claimed_at_ms
                END
              WHERE trigger_id = ${result.triggerId}`
            return
          }
          yield* sql`UPDATE flows_triggers
            SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${result.occurrence}), ${result.occurrence}),
              active_run_id = CASE
                WHEN active_run_id = ${reservationId(result.triggerId, result.occurrence)} THEN NULL
                ELSE active_run_id
              END,
              active_claimed_at_ms = CASE
                WHEN active_run_id = ${reservationId(result.triggerId, result.occurrence)} THEN NULL
                ELSE active_claimed_at_ms
              END
            WHERE trigger_id = ${result.triggerId}`
        })
      ).pipe(
        Effect.asVoid
      ),
    setPending: (fire) =>
      write(Effect.gen(function*() {
        const rows = yield* sql<{ readonly pending_at_ms: number | null }>`
          SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${fire.triggerId}
        `
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(unknownTrigger(fire.triggerId))
        const pending = Overlap.pendingAfter({
          running: true,
          pending: row.pending_at_ms ?? undefined,
          due: fire.occurrence
        })
        yield* sql`UPDATE flows_triggers SET pending_at_ms = ${pending} WHERE trigger_id = ${fire.triggerId}`
      })).pipe(Effect.asVoid),
    takePending: (triggerId) =>
      write(Effect.gen(function*() {
        const rows = yield* sql<
          { readonly pending_at_ms: number | null }
        >`SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${triggerId}`
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(unknownTrigger(triggerId))
        yield* sql`UPDATE flows_triggers SET pending_at_ms = NULL WHERE trigger_id = ${triggerId}`
        return row.pending_at_ms === null ? Option.none() : Option.some(row.pending_at_ms)
      })),
    activeRun: (triggerId) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        return yield* write(Effect.gen(function*() {
          const rows = yield* sql<{
            readonly active_run_id: string | null
            readonly active_claimed_at_ms: number | null
            readonly pending_at_ms: number | null
          }>`SELECT active_run_id, active_claimed_at_ms, pending_at_ms
            FROM flows_triggers WHERE trigger_id = ${triggerId}`
          const row = rows[0]
          if (row === undefined) return yield* Effect.fail(unknownTrigger(triggerId))
          if (row.active_run_id === null) return Option.none()
          if (
            isReservation(row.active_run_id) &&
            (row.active_claimed_at_ms === null || row.active_claimed_at_ms <= now - reservationLeaseMs)
          ) {
            const occurrence = reservationOccurrence(row.active_run_id)
            const unfinished = occurrence === undefined
              ? []
              : yield* sql<{ readonly occurrence_at_ms: number; readonly run_id: string | null }>`
                SELECT occurrence_at_ms, run_id FROM flows_trigger_fires
                WHERE trigger_id = ${triggerId} AND occurrence_at_ms = ${occurrence}
                  AND (outcome IS NULL OR outcome = 'buffered')
              `
            if (occurrence !== undefined && unfinished[0] !== undefined) {
              // A process that died after claiming an occurrence but before
              // launching it left a reservation. The expired lease releases
              // that reservation and re-arms both ordinary and buffered work.
              const pending = Overlap.pendingAfter({
                running: false,
                pending: row.pending_at_ms ?? undefined,
                due: occurrence
              })
              const predecessor = unfinished[0].run_id
              const recovered = predecessor !== null && !isReservation(predecessor) ? predecessor : null
              yield* sql`UPDATE flows_triggers
                SET active_run_id = ${recovered}, active_claimed_at_ms = NULL, pending_at_ms = ${pending}
                WHERE trigger_id = ${triggerId} AND active_run_id = ${row.active_run_id}`
              if (recovered !== null) return Option.some(recovered)
            } else {
              yield* sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
                WHERE trigger_id = ${triggerId} AND active_run_id = ${row.active_run_id}`
            }
            return Option.none()
          }
          return Option.some(row.active_run_id)
        }))
      }),
    activeOccurrence: (triggerId, runId) =>
      read(Effect.gen(function*() {
        yield* requireTrigger(triggerId)
        const reserved = reservationOccurrence(runId)
        if (reserved !== undefined) return Option.some(reserved)
        if (isReservation(runId)) return Option.none()
        const rows = yield* sql<{ readonly occurrence_at_ms: number }>`
          SELECT occurrence_at_ms FROM flows_trigger_fires
          WHERE trigger_id = ${triggerId} AND run_id = ${runId} AND outcome = 'launched'
          ORDER BY occurrence_at_ms DESC LIMIT 1
        `
        return rows[0] === undefined ? Option.none() : Option.some(rows[0].occurrence_at_ms)
      })),
    clearActive: (triggerId, runId) =>
      write(sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
        WHERE trigger_id = ${triggerId} AND active_run_id = ${runId}`).pipe(
        Effect.asVoid
      ),
    history: (query = {}) =>
      historyLimit(query.limit).pipe(
        Effect.flatMap((limit) =>
          // One statement for every query shape: a null parameter disables
          // its predicate, and SQLite reads `LIMIT -1` as no limit. One row
          // past the limit is fetched so the page knows whether a next page
          // exists without a second count query.
          read(sql<FireRow>`
            SELECT trigger_id, occurrence_at_ms, outcome, run_id, error FROM flows_trigger_fires
            WHERE (${query.triggerId ?? null} IS NULL OR trigger_id = ${query.triggerId ?? null})
              AND (${query.runId ?? null} IS NULL OR run_id = ${query.runId ?? null})
              AND (${query.outcome ?? null} IS NULL OR outcome = ${query.outcome ?? null})
              AND (${query.cursor?.occurrence ?? null} IS NULL
                OR occurrence_at_ms < ${query.cursor?.occurrence ?? null}
                OR (occurrence_at_ms = ${query.cursor?.occurrence ?? null} AND trigger_id < ${
            query.cursor?.triggerId ?? null
          }))
            ORDER BY occurrence_at_ms DESC, trigger_id DESC
            LIMIT ${limit === undefined ? -1 : limit + 1}
          `).pipe(Effect.map((rows) => historyPage(rows.map(fireRecord), limit)))
        )
      ),
    inspect: (triggerId) =>
      read(sql<{ readonly active_run_id: string | null; readonly pending_at_ms: number | null }>`
        SELECT active_run_id, pending_at_ms FROM flows_triggers WHERE trigger_id = ${triggerId}
      `).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (row === undefined) return Effect.fail(unknownTrigger(triggerId))
          return Effect.succeed({
            ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
            ...(row.pending_at_ms === null ? {} : { pendingAt: row.pending_at_ms })
          })
        })
      ),
    heartbeat: (host) =>
      Effect.flatMap(
        Clock.currentTimeMillis,
        (tickedAt) =>
          write(sql`INSERT INTO flows_scheduler_heartbeat (host, ticked_at_ms) VALUES (${host}, ${tickedAt})
          ON CONFLICT (host) DO UPDATE SET ticked_at_ms = excluded.ticked_at_ms`)
      ).pipe(Effect.asVoid),
    lastHeartbeat: () =>
      read(sql<{ readonly host: string; readonly ticked_at_ms: number }>`
        SELECT host, ticked_at_ms FROM flows_scheduler_heartbeat ORDER BY ticked_at_ms DESC, host ASC LIMIT 1
      `).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? Option.none<Heartbeat>()
            : Option.some({ host: rows[0].host, tickedAt: rows[0].ticked_at_ms })
        )
      )
  }
})

/**
 * Provides {@link TriggerStore.TriggerStore} backed by SQL.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  TriggerStore,
  TriggerError,
  DurableWriter | SqlClient.SqlClient
> = Layer.effect(TriggerStore)(make)
