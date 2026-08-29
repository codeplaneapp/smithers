import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { Journal, JournalError } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const run = runId("run")
const source = sourceId("producer")

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sourceSeq(sequence),
    eventType: "event",
    payload: { value: sequence }
  }, { disableChecks: true })

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, DurableWriter | SqlClient.SqlClient>
) =>
  it.effect(name, () =>
    body().pipe(
      Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
      Effect.provide(TestClock.layer())
    ))

/** A database decorator: reshapes the enclosing client/writer pair in place. */
type DatabaseDecorator = Layer.Layer<
  DurableWriter | SqlClient.SqlClient,
  never,
  DurableWriter | SqlClient.SqlClient
>

const keepWriter: Layer.Layer<DurableWriter, never, DurableWriter> = Layer.effect(
  DurableWriter,
  Effect.service(DurableWriter)
)

const keepSql: Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> = Layer.effect(
  SqlClient.SqlClient,
  Effect.service(SqlClient.SqlClient)
)

/** Records every compiled statement so the startup load can be inspected. */
const recordingDatabase = (queries: Array<string>): DatabaseDecorator =>
  Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function*() {
        const base = yield* Effect.service(SqlClient.SqlClient)
        return new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (typeof statement.compile === "function") {
              queries.push(statement.compile()[0])
            }
            return statement
          }
        }) as SqlClient.SqlClient
      })
    ),
    keepWriter
  )

/** Forces a scheduling boundary after each lazy allocation-floor read. */
const yieldingFloorDatabase: DatabaseDecorator = Layer.merge(
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (typeof statement.compile !== "function" || !statement.compile()[0].includes("MAX(")) {
            return statement
          }
          return statement.pipe(Effect.tap(() => Effect.yieldNow))
        }
      }) as SqlClient.SqlClient
    })
  ),
  keepWriter
)

const journal = (
  options: SqlJournal.SqlJournalOptions,
  database?: DatabaseDecorator
) =>
  database === undefined
    ? SqlJournal.layer(options)
    : SqlJournal.layer(options).pipe(Layer.provide(database))

const eventCount = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly total: number }>`
    SELECT COUNT(*) AS total FROM flows_journal_events
  `
  return Number(rows[0]!.total)
})

const seed = (count: number, options: SqlJournal.SqlJournalOptions) =>
  Effect.gen(function*() {
    const service = yield* Journal
    for (let index = 0; index < count; index++) {
      yield* service.emitLossy(input(index))
    }
    yield* service.flush
  }).pipe(Effect.provide(journal(options)), Effect.scoped)

describe("SqlJournal source-event retention", () => {
  effect("bounds the startup load instead of decoding every historical event", () =>
    Effect.gen(function*() {
      yield* seed(6, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(5))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )
      const load = queries.find((query) =>
        query.includes("FROM flows_journal_events") && !query.includes("MAX(") && !query.includes("INSERT")
      )
      expect(load).toBeDefined()
      expect(load).toContain("LIMIT")
      // The retained window answers from memory; everything older falls through
      // to the durable duplicate check in the writer.
      expect(receipts.newest._tag).toBe("Duplicate")
      expect(receipts.oldest._tag).toBe("Accepted")
      // The fall-through never duplicates a durable row.
      expect(yield* eventCount).toBe(6)
    }))

  effect("evicts committed entries once the index exceeds the bound", () =>
    Effect.gen(function*() {
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 5; index++) {
          yield* service.emitLossy(input(index))
        }
        yield* service.flush
        return {
          oldest: yield* service.emitLossy(input(0)),
          newest: yield* service.emitLossy(input(4))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )
      expect(receipts.newest._tag).toBe("Duplicate")
      expect(receipts.oldest._tag).toBe("Accepted")
      expect(yield* eventCount).toBe(5)
    }))

  effect("never evicts an uncommitted entry, so pending dedup still holds", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const database: DatabaseDecorator = Layer.merge(
        Layer.effect(
          DurableWriter,
          Effect.gen(function*() {
            const inner = yield* DurableWriter
            return DurableWriter.of({
              write: (write) => Deferred.await(gate).pipe(Effect.andThen(inner.write(write)))
            })
          })
        ),
        keepSql
      )
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 4; index++) {
          yield* service.emitLossy(input(index))
        }
        const observed = yield* Effect.forEach([0, 1, 2, 3], (index) => service.emitLossy(input(index)))
        yield* Deferred.succeed(gate, undefined)
        yield* service.flush
        return observed
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 1 }, database)),
        Effect.scoped
      )
      expect(receipts.map((receipt) => receipt._tag)).toEqual([
        "Duplicate",
        "Duplicate",
        "Duplicate",
        "Duplicate"
      ])
    }))

  effect("rejects a non-positive source-event cache bound", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Effect.scoped(
          Effect.provide(Effect.void, journal({ capacity: 8, overflow: "reject", sourceEventCache: 0 }))
        )
      )
      expect(failure).toBeInstanceOf(JournalError)
      expect((failure as JournalError).code).toBe("invalid_event")
    }))
})

describe("SqlJournal allocation-floor index bounds (B9)", () => {
  effect("aggregates no run history at construction", () =>
    Effect.gen(function*() {
      yield* seed(6, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const atConstruction = yield* Effect.gen(function*() {
        yield* Journal
        return [...queries]
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )

      // The `sequences` and `sourceSequences` floors used to be seeded by two
      // unbounded `GROUP BY` aggregations — one entry per run that ever wrote
      // an event, one per (run, source) pair — so construction scanned the
      // whole table and built a map proportional to total history whatever
      // `sourceEventCache` said. The startup load is now the bounded
      // source-event window and nothing else.
      expect(atConstruction.filter((query) => query.includes("GROUP BY"))).toEqual([])
      const load = atConstruction.filter((query) => query.includes("FROM flows_journal_events"))
      expect(load).toHaveLength(1)
      expect(load[0]).toContain("LIMIT")
    }))

  effect("reads a run's allocation floor on first use, and only once", () =>
    Effect.gen(function*() {
      yield* seed(3, { capacity: 64, overflow: "reject" })
      const queries: Array<string> = []
      const receipts = yield* Effect.gen(function*() {
        const service = yield* Journal
        return {
          first: yield* service.emitLossy(input(3)),
          second: yield* service.emitLossy(input(4))
        }
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 }, recordingDatabase(queries))),
        Effect.scoped
      )

      // Dropping the seed cannot restart allocation at zero: the floor the
      // aggregation used to precompute is read from the same durable
      // `MAX(...) + 1` on first use.
      expect(receipts.first).toMatchObject({ seq: 3, sourceSeq: 3 })
      expect(receipts.second).toMatchObject({ seq: 4, sourceSeq: 4 })
      // And it is cached: the second emit on the same run re-reads nothing.
      expect(queries.filter((query) => query.includes("MAX(seq) + 1"))).toHaveLength(1)
    }))

  effect("serializes concurrent first-use allocation-floor reads", () =>
    Effect.gen(function*() {
      const result = yield* Effect.gen(function*() {
        const service = yield* Journal
        const receipts = yield* Effect.all(
          [service.emitLossy(input(0)), service.emitLossy(input(1))],
          { concurrency: "unbounded" }
        )
        yield* service.flush
        const page = yield* service.entries({ runId: run, limit: 10 })
        return { receipts, entries: page.entries }
      }).pipe(
        Effect.provide(
          journal(
            { capacity: 64, overflow: "reject", sourceEventCache: 2 },
            yieldingFloorDatabase
          )
        ),
        Effect.scoped
      )

      // Lazy initialization crosses an asynchronous SQL boundary. Without an
      // allocation permit, both first emits can read seq 0 before either one
      // raises the in-process floor, queue duplicate canonical sequences, and
      // lose the batch to `sequence_conflict` at flush.
      expect(result.receipts.map((receipt) => receipt.seq)).toEqual([0, 1])
      expect(result.entries.map((entry) => entry.seq)).toEqual([0, 1])
    }))
})

/**
 * The JSDoc on `sourceEventCache` (SqlJournal.ts:60-71) states that bounding the
 * in-process index is safe because "the writer's `insertOne` always re-checks
 * `flows_journal_events` under the `(run_id, source_id, source_seq)` unique
 * constraint, so an evicted entry re-emitted later is still deduplicated
 * durably and still reports an `idempotency_conflict` on changed content."
 *
 * The neighbouring cells drive eviction and observe the in-memory miss. Neither
 * drives the eviction and the re-emission *through the writer*, which is where
 * that claim is actually implemented — so the bound's safety argument rested on
 * an unasserted durable re-check.
 */
describe("SqlJournal durable dedup behind an evicted index entry", () => {
  effect("deduplicates an evicted source event durably on re-emission", () =>
    Effect.gen(function*() {
      const total = yield* Effect.gen(function*() {
        const service = yield* Journal
        for (let index = 0; index < 5; index++) {
          yield* service.emitLossy(input(index))
        }
        yield* service.flush
        // Entry 0 is long past the two-entry window, so this is an in-memory
        // miss: the receipt is `Accepted` and the entry reaches the queue.
        const reEmitted = yield* service.emitLossy(input(0))
        expect(reEmitted._tag).toBe("Accepted")
        // The writer is what has to catch it. Flush so `insertOne` runs.
        yield* service.flush
        return yield* eventCount
      }).pipe(
        Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
        Effect.scoped
      )

      // No sixth row: the unique constraint re-check collapsed the accepted
      // re-emission into the durable original.
      expect(total).toBe(5)
    }))

  effect(
    "reports idempotency_conflict for an evicted source event re-emitted with changed content",
    () =>
      Effect.gen(function*() {
        const outcome = yield* Effect.gen(function*() {
          const service = yield* Journal
          for (let index = 0; index < 5; index++) {
            yield* service.emitLossy(input(index))
          }
          yield* service.flush
          // Same (run, source, sourceSeq) as entry 0, different payload.
          yield* service.emitLossy(
            new Input({
              runId: run,
              sourceId: source,
              sourceSeq: sourceSeq(0),
              eventType: "event",
              payload: { value: "changed" }
            }, { disableChecks: true })
          )
          const failure = yield* Effect.flip(service.flush)
          return { failure, total: yield* eventCount }
        }).pipe(
          Effect.provide(journal({ capacity: 64, overflow: "reject", sourceEventCache: 2 })),
          Effect.scoped
        )

        // The in-memory index could not answer, so the durable re-check is what
        // detected the reuse — the second half of the bound's safety argument.
        expect(outcome.failure).toBeInstanceOf(JournalError)
        expect((outcome.failure as JournalError).code).toBe("idempotency_conflict")
        expect(outcome.total).toBe(5)
      })
  )
})
