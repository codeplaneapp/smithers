/**
 * Reading the durable state a killed host left behind.
 *
 * The assertions in the crash family are about rows in a SQLite file, not about
 * anything a test process remembered, so they are read here through the shipped
 * stores over a fresh connection.
 *
 * @since 1.0.0
 */
import { DurableEngineState } from "@smthrs/engine-store"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const storage = (filename: string) =>
  NodeRuntime.storage(filename).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeHost.layer, NodeHost.NodeCrypto.layer))
  )

/** Reads the actual persisted deadlines without arming an engine host. */
export const pendingClocks = (
  filename: string,
  executionId: string
): Promise<ReadonlyArray<DurableEngineState.ClockRow>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      return yield* state.pendingClocks({ executionId })
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/** Reads committed timer identity, its first completion, and the full host records. */
export const timerEvidence = (filename: string, address: DurableEngineState.ClockRow) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      const clock = yield* state.clock(address)
      const deferred = yield* state.deferred(address)
      const page = yield* journal.entries({ runId: address.executionId as JournalEvent.RunId, limit: 1_000 })
      return {
        clock: Option.getOrUndefined(clock),
        deferred: Option.getOrUndefined(deferred),
        entries: page.entries
      }
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/**
 * The waiting row an execution is parked on, if it is parked at all.
 *
 * @since 1.0.0
 * @category getters
 */
export const waitingRow = (
  filename: string,
  executionId: string
): Promise<{ readonly reason: string; readonly token: string | null } | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId)
      if (Option.isNone(row)) return undefined
      return { reason: String(row.value.reason), token: row.value.token }
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/**
 * Every journal event type recorded for one run, in sequence order.
 *
 * @since 1.0.0
 * @category getters
 */
export const journalEventTypes = (
  filename: string,
  runId: string,
  limit = 1_000
): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit })
      return page.entries.map((entry) => entry.eventType)
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )
