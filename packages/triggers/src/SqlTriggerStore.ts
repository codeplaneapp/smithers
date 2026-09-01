/**
 * SQLite-backed trigger store.
 *
 * @see docs/specs/Concepts/Flow Triggers.md
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "./migrations/index.ts"
import * as Overlap from "./Overlap.ts"
import * as Schedule from "./Schedule.ts"
import { TriggerError } from "./TriggerError.ts"
import { type Registered, type Service, TriggerStore } from "./TriggerStore.ts"

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

const storeError = (message: string, cause?: unknown) =>
  new TriggerError({
    code: "store",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const changes = (result: unknown): number =>
  typeof result === "object" &&
    result !== null &&
    "changes" in result &&
    typeof result.changes === "number"
    ? result.changes
    : 0

const decode = (row: Row): Effect.Effect<Registered, TriggerError> =>
  Effect.try({
    try: () => ({
      id: row.trigger_id,
      flowId: row.flow_id,
      input: JSON.parse(row.input_json) as unknown,
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
  yield* Migrations.run.pipe(Effect.mapError((cause) => storeError("could not run trigger migrations", cause)))
  const read = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, TriggerError> =>
    effect.pipe(
      Effect.mapError((cause) => storeError("trigger store read failed", cause))
    )
  const write = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, TriggerError> =>
    writer.write(effect).pipe(
      Effect.mapError((cause) => storeError("trigger store write failed", cause))
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
        }))
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
    due: (_now) =>
      read(sql<Row>`SELECT * FROM flows_triggers WHERE enabled = 1 ORDER BY trigger_id`).pipe(
        Effect.flatMap((rows) => Effect.all(rows.map(decode)))
      ),
    claimFire: (fire) =>
      Effect.gen(function*() {
        const claimedAt = yield* Clock.currentTimeMillis
        return yield* write(Effect.gen(function*() {
          const inserted = yield* sql`
          INSERT INTO flows_trigger_fires (trigger_id, occurrence_at_ms)
          VALUES (${fire.triggerId}, ${fire.occurrence})
          ON CONFLICT (trigger_id, occurrence_at_ms) DO NOTHING
        `.raw
          let existingOutcome: string | null | undefined
          if (changes(inserted) === 0) {
            const existing = yield* sql<{ readonly outcome: string | null }>`
            SELECT outcome FROM flows_trigger_fires
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}
          `
            existingOutcome = existing[0]?.outcome
          }
          const rows = yield* sql<{
            readonly active_run_id: string | null
            readonly active_claimed_at_ms: number | null
          }>`SELECT active_run_id, active_claimed_at_ms FROM flows_triggers WHERE trigger_id = ${fire.triggerId}`
          if (rows[0] === undefined) {
            return yield* Effect.fail(storeError(`unknown trigger ${fire.triggerId}`))
          }
          let activeRunId = rows[0].active_run_id ?? undefined
          const reservationId = `trigger-reservation:${fire.triggerId}:${fire.occurrence}`
          const reservationExpired = activeRunId?.startsWith("trigger-reservation:") === true &&
            rows[0].active_claimed_at_ms !== null &&
            rows[0].active_claimed_at_ms <= claimedAt - reservationLeaseMs
          if (existingOutcome !== undefined) {
            const resumableBuffer = fire.resumeBuffered === true && existingOutcome === "buffered"
            const resumableReservation = existingOutcome === null &&
              (activeRunId === undefined || (activeRunId === reservationId && reservationExpired))
            if (!resumableBuffer && !resumableReservation) return { claimed: false as const }
          }
          if (reservationExpired) {
            yield* sql`UPDATE flows_triggers SET active_run_id = NULL, active_claimed_at_ms = NULL
            WHERE trigger_id = ${fire.triggerId} AND active_run_id = ${activeRunId ?? null}`
            activeRunId = undefined
          }
          const action = Overlap.decide(fire.overlap, {
            running: activeRunId !== undefined,
            due: fire.occurrence
          })
          if (action === "skip") {
            yield* sql`UPDATE flows_trigger_fires SET outcome = 'skipped'
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}`
            yield* sql`UPDATE flows_triggers SET last_fired_at_ms = ${fire.occurrence}
            WHERE trigger_id = ${fire.triggerId}`
            return { claimed: true as const, action }
          }
          if (action === "buffer") {
            yield* sql`UPDATE flows_trigger_fires SET outcome = 'buffered'
            WHERE trigger_id = ${fire.triggerId} AND occurrence_at_ms = ${fire.occurrence}`
            yield* sql`UPDATE flows_triggers
            SET last_fired_at_ms = ${fire.occurrence},
              pending_at_ms = CASE
                WHEN pending_at_ms IS NULL OR pending_at_ms < ${fire.occurrence}
                  THEN ${fire.occurrence}
                ELSE pending_at_ms
              END
            WHERE trigger_id = ${fire.triggerId}`
            return { claimed: true as const, action }
          }
          yield* sql`UPDATE flows_triggers SET active_run_id = ${reservationId}, active_claimed_at_ms = ${claimedAt}
          WHERE trigger_id = ${fire.triggerId}`
          return {
            claimed: true as const,
            action,
            reservationId,
            ...(activeRunId === undefined ? {} : { activeRunId })
          }
        }))
      }),
    recordResult: (result) =>
      write(
        Effect.gen(function*() {
          yield* sql`UPDATE flows_trigger_fires
            SET outcome = ${result.outcome}, run_id = ${result.runId ?? null}, error = ${result.error ?? null}
            WHERE trigger_id = ${result.triggerId} AND occurrence_at_ms = ${result.occurrence}`
          if (result.outcome === "launched") {
            yield* sql`UPDATE flows_triggers
              SET last_fired_at_ms = ${result.occurrence}, active_run_id = ${result.runId ?? null},
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
              SET last_fired_at_ms = ${result.occurrence},
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
            SET last_fired_at_ms = ${result.occurrence},
              active_run_id = CASE
                WHEN active_run_id = ${`trigger-reservation:${result.triggerId}:${result.occurrence}`} THEN NULL
                ELSE active_run_id
              END,
              active_claimed_at_ms = CASE
                WHEN active_run_id = ${`trigger-reservation:${result.triggerId}:${result.occurrence}`} THEN NULL
                ELSE active_claimed_at_ms
              END
            WHERE trigger_id = ${result.triggerId}`
        })
      ).pipe(
        Effect.asVoid
      ),
    setPending: (fire) =>
      write(
        sql`UPDATE flows_triggers SET pending_at_ms = CASE WHEN pending_at_ms IS NULL OR pending_at_ms < ${fire.occurrence} THEN ${fire.occurrence} ELSE pending_at_ms END WHERE trigger_id = ${fire.triggerId}`
      ).pipe(Effect.asVoid),
    takePending: (triggerId) =>
      write(Effect.gen(function*() {
        const rows = yield* sql<
          { readonly pending_at_ms: number | null }
        >`SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${triggerId}`
        const pending = rows[0]?.pending_at_ms
        yield* sql`UPDATE flows_triggers SET pending_at_ms = NULL WHERE trigger_id = ${triggerId}`
        return pending === undefined || pending === null ? Option.none() : Option.some(pending)
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
          if (row === undefined || row.active_run_id === null) return Option.none()
          if (
            row.active_run_id.startsWith("trigger-reservation:") &&
            row.active_claimed_at_ms !== null &&
            row.active_claimed_at_ms <= now - reservationLeaseMs
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
