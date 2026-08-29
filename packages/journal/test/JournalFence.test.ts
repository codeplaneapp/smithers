/**
 * The journal's durable channel accepts an `OwnerId` and fences the append on
 * it: the INSERT only lands while `flows_runs` still records that owner as the
 * running run's owner, and otherwise the append fails `fence_lost` rather than
 * writing behind a live successor.
 *
 * `flows_runs` belongs to `@smthrs/run-store`, which depends on this package
 * and so cannot be depended on from here. This suite therefore stands up the
 * *columns the fence reads* as a fixture, which is exactly the contract the
 * journal asserts on a table it does not own. `@smthrs/engine-store` — which
 * composes both — pins the same behaviour against the real migrated schema in
 * its `JournalFencing` suite.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

const input = (run: RunId, source: SourceId, sourceSeq: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq as SourceSeq,
    eventType: "flows.engine.run-decision",
    payload: { decision: "created" }
  }, { disableChecks: true })

/** The `flows_runs` columns the fenced append's `WHERE EXISTS` reads. */
const fenceTable = Layer.effectDiscard(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    owner_host_id TEXT,
    owner_pid INTEGER,
    owner_nonce TEXT
  )`
}))

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(
    Layer.provideMerge(Layer.provideMerge(fenceTable, Migrations.layer), TestDatabase.layer)
  )
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer())))

const claim = (sql: SqlClient.SqlClient, run: RunId, holder: OwnerId) =>
  sql`INSERT INTO flows_runs (run_id, status, owner_host_id, owner_pid, owner_nonce)
      VALUES (${run}, 'running', ${holder.hostId}, ${holder.pid}, ${holder.nonce})`

const reclaim = (sql: SqlClient.SqlClient, run: RunId, holder: OwnerId) =>
  sql`UPDATE flows_runs
      SET owner_host_id = ${holder.hostId}, owner_pid = ${holder.pid}, owner_nonce = ${holder.nonce}
      WHERE run_id = ${run}`

describe("SqlJournal durable fencing", () => {
  it.effect("commits a fenced append while the supplied owner still holds the run", () =>
    Effect.gen(function*() {
      const receipt = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-commit")
        yield* claim(sql, run, owner)
        return yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
      }))

      expect(receipt._tag).toBe("Accepted")
    }))

  it.effect("fails the append with fence_lost once the run has a different owner", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-lost")
        yield* claim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.emitDurable(input(run, sourceId("driver"), 0), owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  it.effect("treats a malformed owner as a lost fence rather than a driver failure", () =>
    Effect.gen(function*() {
      // `OwnerId` is `Schema.String`/`Schema.Number` with no runtime refinement,
      // so a caller can hand the fence an empty identifier or a non-integral pid.
      // The fence is a `WHERE EXISTS` comparison, so none of these can match the
      // claimed row — the contract being pinned is that each is reported as the
      // typed `fence_lost` a zombie owner gets, never a raw SQL/driver error and
      // never a silent append behind the live owner.
      const malformed: ReadonlyArray<OwnerId> = [
        { hostId: "", pid: 42, nonce: "nonce-a" },
        { hostId: "host-a", pid: 42, nonce: "" },
        { hostId: "host-a", pid: 42.5, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.NaN, nonce: "nonce-a" },
        { hostId: "host-a", pid: Number.POSITIVE_INFINITY, nonce: "nonce-a" }
      ]

      const result = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-malformed")
        yield* claim(sql, run, owner)
        const failures = yield* Effect.forEach(
          malformed,
          (holder, index) => Effect.flip(journal.emitDurable(input(run, sourceId("driver"), index), holder))
        )
        const rows = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${run}
      `
        return { failures, total: Number(rows[0]!.total) }
      }))

      for (const failure of result.failures) {
        expect(failure).toBeInstanceOf(JournalError)
        expect((failure as JournalError).code).toBe("fence_lost")
      }
      // The legitimate owner's run gains no rows from any of them.
      expect(result.total).toBe(0)
    }))

  it.effect("stays idempotent when a fenced retry re-emits an already-committed entry", () =>
    Effect.gen(function*() {
      const receipts = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-retry")
        yield* claim(sql, run, owner)
        const first = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        const second = yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        return [first, second] as const
      }))

      expect(receipts[0]._tag).toBe("Accepted")
      expect(receipts[1]._tag).toBe("Duplicate")
    }))

  it.effect("rejects a checkpoint from a superseded owner with fence_lost", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-checkpoint-superseded")
        yield* claim(sql, run, owner)
        yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        // The run is reclaimed under a new owner; the old owner's fence is gone.
        yield* reclaim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.checkpoint({ runId: run, seq: 0 as Seq, state: null }, owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))

  it.effect("rejects a compaction from a superseded owner with fence_lost", () =>
    Effect.gen(function*() {
      const failure = yield* withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("fenced-compact-superseded")
        yield* claim(sql, run, owner)
        yield* journal.emitDurable(input(run, sourceId("driver"), 0), owner)
        yield* journal.checkpoint({ runId: run, seq: 0 as Seq, state: null }, owner)
        // The run is reclaimed under a new owner; the old owner's fence is gone.
        yield* reclaim(sql, run, { hostId: "host-b", pid: 7, nonce: "nonce-b" })
        return yield* Effect.flip(journal.compact({ runId: run }, owner))
      }))

      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("fence_lost")
    }))
})
