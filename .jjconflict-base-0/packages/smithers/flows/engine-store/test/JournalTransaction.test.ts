/**
 * Pins the WAL/state atomicity seam ACROSS packages: `@smthrs/journal`'s
 * `transact` runs a `@smthrs/run-store` state projection and the lifecycle
 * entries describing it in ONE write transaction, because both stores write
 * through the same `DurableWriter` and so join it as savepoints. The
 * journal-only half of the contract stays in `@smthrs/journal`.
 *
 * Prior art: `reference/temporal/service/history/workflow/transaction_impl.go`
 * submits the mutable-state mutation and its event batches as one persistence
 * request.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal } from "@smthrs/journal/Journal"
import { Input, type RunId, type SourceId, type SourceSeq } from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, PubSub } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

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

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.merge(RunStore.layer),
  Layer.provideMerge(migratedDatabase)
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack)))

const rowsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  sql<{ readonly seq: number; readonly event_type: string }>`
    SELECT seq, event_type FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

class Rejected extends Error {
  override readonly name = "Rejected"
}

describe("Journal.transact across the journal and run stores", () => {
  effect(
    "commits a lifecycle entry and the state projection it describes together",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const runs = yield* RunStore.RunStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("atomic-commit")

        yield* journal.transact(Effect.gen(function*() {
          yield* runs.create(run, "{}")
          yield* journal.emitDurableUnfenced(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
          )
        }))

        const row = yield* runs.get(run)
        const rows = yield* rowsOf(sql, run)
        expect(row.status).toBe("pending")
        expect(rows.map((entry) => entry.event_type)).toEqual(["flows.engine.run-decision"])
      }))
  )

  effect("rolls the lifecycle entry back with the state write it describes", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-rollback")

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
        yield* journal.emitDurableUnfenced(
          input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
        )
        return yield* Effect.fail(new Rejected("state transition rejected after the WAL append"))
      })).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      const missing = yield* runs.get(run).pipe(Effect.flip)
      const rows = yield* rowsOf(sql, run)
      // Journal/state equivalence: neither half of the pair survives.
      expect(missing.code).toBe("not_found_row")
      expect(rows).toHaveLength(0)
    })))

  effect("settles a nested transaction once, at the outermost commit", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-nested")
      const subscription = yield* journal.changes

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
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
})
