/**
 * Pins the WAL side of the atomicity seam: `Journal.transact` runs its body
 * and the lifecycle entries describing it in ONE write transaction, and
 * publishes those entries only once that transaction has committed. The
 * cross-package half — a `@smthrs/run-store` state write committing or rolling
 * back with its entry — lives in `@smthrs/engine-store`, which composes both.
 *
 * Prior art: `reference/temporal/service/history/workflow/transaction_impl.go`
 * submits the mutable-state mutation and its event batches as one persistence
 * request.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber, Layer, PubSub } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal, JournalError, makeNoop } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it.effect(name, () => body().pipe(Effect.provide(TestClock.layer())))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: 0 as SourceSeq,
    eventType,
    payload
  }, { disableChecks: true })

const allocatedInput = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    eventType,
    payload
  })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(migratedDatabase)
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack)))

const rowsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  sql<{ readonly seq: number; readonly source_seq: number; readonly event_type: string }>`
    SELECT seq, source_seq, event_type FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

class Rejected extends Error {
  override readonly name = "Rejected"
}

describe("Journal.transact", () => {
  effect("rolls a committed entry back with the transaction that wrote it", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-rollback")

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* journal.emitDurableUnfenced(
          input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
        )
        return yield* Effect.fail(new Rejected("rejected after the WAL append"))
      })).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* rowsOf(sql, run)).toHaveLength(0)
    })))

  effect("leaves a rolled-back producer identity re-emittable", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-reemit")
      const record = () => input(run, sourceId("driver"), "flows.engine.attempt-finished", { state: "succeeded" })

      yield* journal.transact(
        journal.emitDurableUnfenced(record()).pipe(
          Effect.andThen(Effect.fail(new Rejected("rolled back")))
        )
      ).pipe(Effect.exit)

      // The in-process source index must not vouch for the rolled-back write:
      // a retry has to reach SQL again, not collapse into a phantom Duplicate.
      const receipt = yield* journal.emitDurableUnfenced(record())
      const rows = yield* rowsOf(sql, run)
      expect(receipt._tag).toBe("Accepted")
      expect(rows.map((entry) => entry.seq)).toEqual([receipt.seq])
    })))

  effect(
    "publishes committed entries to subscribers only after the transaction commits",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const run = runId("atomic-publish")
        const subscription = yield* journal.changes

        const pendingInside = yield* journal.transact(Effect.gen(function*() {
          yield* journal.emitDurableUnfenced(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "a" })
          )
          return yield* PubSub.remaining(subscription)
        }))

        expect(pendingInside).toBe(0)
        expect(yield* PubSub.remaining(subscription)).toBe(1)
      }))
  )

  effect("settles a nested transaction once, at the outermost commit", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-nested")
      const subscription = yield* journal.changes

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* journal.transact(
          journal.emitDurableUnfenced(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "nested" })
          )
        )
        return yield* Effect.fail(new Rejected("outer rejected after the inner append"))
      })).pipe(Effect.exit)

      // The inner transaction is a savepoint of the outer one, so the outer
      // rollback takes the inner append with it — and nothing was published.
      expect(exit._tag).toBe("Failure")
      expect(yield* PubSub.remaining(subscription)).toBe(0)
      expect(yield* rowsOf(sql, run)).toHaveLength(0)
    })))

  effect("reports a storage failure as a journal error", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const failure = yield* journal.transact(
        sql`SELECT 1 FROM flows_no_such_table`
      ).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("sink_failed")
    })))

  effect("the closed stub runs the effect directly", () =>
    Effect.gen(function*() {
      const closed = makeNoop()
      expect(yield* closed.transact(Effect.succeed(7))).toBe(7)
    }))
})

describe("Journal.emitLossy against an open transaction", () => {
  effect(
    "does not collide with a seq a still-open transact already allocated (B6)",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("lossy-vs-open-transact")

        yield* journal.emitDurableUnfenced(input(run, sourceId("durable-a"), "first", { value: 0 }))

        // The lossy emit allocates its seq from `state.sequences` alone, while
        // the durable emit inside the open transact has already consumed that
        // value and parks `rememberCommitted` until the outermost COMMIT.
        yield* journal.transact(Effect.gen(function*() {
          yield* journal.emitDurableUnfenced(input(run, sourceId("durable-b"), "second", { value: 1 }))
          yield* journal.emitLossy(input(run, sourceId("telemetry"), "lossy", { value: 2 }))
        }))
        yield* journal.flush

        const rows = yield* rowsOf(sql, run)
        expect(rows.map((row) => row.event_type)).toEqual(["first", "second", "lossy"])
        expect(rows.map((row) => row.seq)).toEqual([0, 1, 2])
      }))
  )

  effect(
    "reserves a durable producer sequence before an open transaction commits",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("lossy-source-vs-open-transact")
        const source = sourceId("shared-producer")
        const release = yield* Deferred.make<void>()
        const ready = yield* Deferred.make<void>()
        const lossy = yield* Effect.gen(function*() {
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          return yield* journal.emitLossy(allocatedInput(run, source, "lossy", { value: 2 }))
        }).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(ready)
        yield* journal.transact(Effect.gen(function*() {
          yield* journal.emitDurableUnfenced(allocatedInput(run, source, "durable", { value: 1 }))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(lossy)
        }))
        yield* journal.flush

        const rows = yield* rowsOf(sql, run)
        expect(rows.map((row) => row.event_type)).toEqual(["durable", "lossy"])
        expect(rows.map((row) => row.seq)).toEqual([0, 1])
        expect(rows.map((row) => row.source_seq)).toEqual([0, 1])
      }))
  )
})
