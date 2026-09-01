/**
 * SQLite-backed trigger store.
 *
 * @see packages/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import { affectedRows, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "./migrations/index.ts"
import * as Overlap from "./Overlap.ts"
import * as Schedule from "./Schedule.ts"
import { TriggerError } from "./TriggerError.ts"
import {
  type Claim,
  isReservation,
  type Registered,
  reservationId,
  type Service,
  TriggerStore
} from "./TriggerStore.ts"

/**
 * Time after which an uncommitted launch reservation may be reclaimed.
 *
 * @category constants
 * @since 0.1.0
 */
export const reservationLeaseMs = 5 * 60 * 1000

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
  return {
    register: (trigger) =>
      // Registration is the last point where an unsatisfiable expression can
      // still be refused: once the row exists, every tick that reads it has to
      // handle a search that never terminates in a match.
      Schedule.validate(trigger).pipe(
        Effect.andThen(Effect.try({
          try: () => JSON.stringify(trigger.input),
          catch: (cause) => storeError("trigger input is not JSON-serializable", cause)
        })),
        // `JSON.stringify` answers `undefined` rather than throwing for an
        // input it cannot represent, so the `catch` above never sees it and
        // the value reached a NOT NULL column as a generic write failure.
        Effect.flatMap((input) =>
          input === undefined
            ? Effect.fail(
              new TriggerError({
                code: "invalid_trigger",
                message: "trigger input has no JSON representation",
                path: "input"
              })
            )
            : Effect.succeed(input)
        )
      ).pipe(
        Effect.flatMap((input) =>
          write(sql`
        INSERT INTO flows_triggers (trigger_id, flow_id, input_json, cron, timezone, overlap, catch_up, max_catch_up, enabled, revision)
        VALUES (${trigger.id}, ${trigger.flowId}, ${input}, ${trigger.cron}, ${
            trigger.timezone ?? null
          }, ${trigger.overlap}, ${trigger.catchUp}, ${trigger.maxCatchUp}, ${trigger.enabled ? 1 : 0}, 1)
        ON CONFLICT (trigger_id) DO UPDATE SET flow_id = excluded.flow_id, input_json = excluded.input_json, cron = excluded.cron,
          timezone = excluded.timezone, overlap = excluded.overlap, catch_up = excluded.catch_up, max_catch_up = excluded.max_catch_up,
          enabled = excluded.enabled, revision = flows_triggers.revision + 1
      `.pipe(
            Effect.flatMap(() => get(trigger.id)),
            Effect.flatMap((registered) =>
              Option.isSome(registered)
                ? Effect.succeed(registered.value)
                : Effect.fail(storeError("registered trigger disappeared"))
            )
          ))
        )
      ),
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
        return yield* write(Effect.gen(function*() {
          // The declaration is read first and inside the transaction, so the
          // policy applied is the stored one and a caller holding a snapshot
          // from before an edit is refused rather than obeyed.
          const rows = yield* sql<ClaimRow>`
            SELECT enabled, revision, overlap, active_run_id, active_claimed_at_ms, pending_at_ms
            FROM flows_triggers WHERE trigger_id = ${fire.triggerId}
          `
          const row = rows[0]
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
          if (inserted === 0) {
            const existing = yield* sql<{ readonly outcome: string | null }>`
            SELECT outcome FROM flows_trigger_fires
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}
          `
            existingOutcome = existing[0]?.outcome
          }
          let activeRunId = row.active_run_id ?? undefined
          const reservation = reservationId(fire.triggerId, fire.occurrence)
          // A reservation with no claim timestamp predates the lease column.
          // Nothing writes that shape now, so treating it as expired is the
          // only way such a row is ever reclaimed.
          const expiredReservation = activeRunId !== undefined && isReservation(activeRunId) &&
              (row.active_claimed_at_ms === null || row.active_claimed_at_ms <= claimedAt - reservationLeaseMs)
            ? activeRunId
            : undefined
          const reservationExpired = expiredReservation !== undefined
          if (existingOutcome !== undefined) {
            const resumableBuffer = fire.resumeBuffered === true && existingOutcome === "buffered"
            const resumableReservation = existingOutcome === null &&
              (activeRunId === undefined || (activeRunId === reservation && reservationExpired))
            if (!resumableBuffer && !resumableReservation) return { claimed: false as const }
          }
          if (expiredReservation !== undefined) {
            yield* sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
            WHERE trigger_id = ${fire.triggerId} AND active_run_id = ${expiredReservation}`
            activeRunId = undefined
          }
          const state: Overlap.State = {
            running: activeRunId !== undefined,
            pending: row.pending_at_ms ?? undefined,
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
          yield* sql`UPDATE flows_triggers SET active_run_id = ${reservation}, active_claimed_at_ms = ${claimedAt}
          WHERE trigger_id = ${fire.triggerId}`
          return {
            claimed: true as const,
            action,
            reservationId: reservation,
            ...(activeRunId === undefined ? {} : { activeRunId })
          }
        }))
      }),
    recordResult: (result) =>
      write(
        Effect.gen(function*() {
          yield* requireTrigger(result.triggerId)
          yield* sql`UPDATE flows_trigger_fires
            SET outcome = ${result.outcome}, run_id = ${result.runId ?? null}, error = ${result.error ?? null}
            WHERE trigger_id = ${result.triggerId} AND occurrence_at_ms = ${result.occurrence}`
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
          if (
            result.outcome === "completed" ||
            result.outcome === "failed" ||
            result.outcome === "superseded"
          ) {
            yield* sql`UPDATE flows_triggers
              SET last_fired_at_ms = MAX(COALESCE(last_fired_at_ms, ${result.occurrence}), ${result.occurrence}),
                active_run_id = CASE
                  WHEN ${result.runId ?? null} IS NULL OR active_run_id = ${result.runId ?? null}
                    THEN NULL
                  ELSE active_run_id
                END,
                active_claimed_at_ms = CASE
                  WHEN ${result.runId ?? null} IS NULL OR active_run_id = ${result.runId ?? null}
                    THEN NULL
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
          }>`SELECT active_run_id, active_claimed_at_ms FROM flows_triggers WHERE trigger_id = ${triggerId}`
          const row = rows[0]
          if (row === undefined) return yield* Effect.fail(unknownTrigger(triggerId))
          if (row.active_run_id === null) return Option.none()
          if (
            isReservation(row.active_run_id) &&
            (row.active_claimed_at_ms === null || row.active_claimed_at_ms <= now - reservationLeaseMs)
          ) {
            yield* sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
            WHERE trigger_id = ${triggerId} AND active_run_id = ${row.active_run_id}`
            return Option.none()
          }
          return Option.some(row.active_run_id)
        }))
      }),
    clearActive: (triggerId, runId) =>
      write(sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
        WHERE trigger_id = ${triggerId} AND active_run_id = ${runId}`).pipe(
        Effect.asVoid
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
