/**
 * The reader/compactor race against a real file-backed SQLite database, with
 * the reader and the compactor on separate connections.
 *
 * `JournalCompaction.test.ts` runs the same race through an in-memory database
 * and an SQL proxy, where the "concurrent" compaction is really the same
 * connection reentered. The ordering `readPage` relies on — read the page, then
 * read the compaction floor, so any truncation that could have shortened the
 * page is visible in the floor — is a claim about two *transactions*, and only
 * a second connection to a real file can put a committed DELETE between them.
 *
 * The contract: a paged read is either a complete history or a typed
 * `compacted` carrying the resync point. A silently shortened or gapped page is
 * the one outcome that must be impossible, because a caller cannot tell it from
 * a genuine end of history.
 *
 * Child processes are not available to this package's tooling, so the compactor
 * is a second `NodeDatabase` connection in this process. The SQLite transaction
 * boundary it commits across is the same one a second process would cross.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Journal, type Service } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const run = runId("compaction-race")
const source = sourceId("producer")

const input = (sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: sequence as SourceSeq,
    eventType: "event",
    payload: { value: sequence }
  }, { disableChecks: true })

const options: SqlJournal.SqlJournalOptions = { capacity: 64, overflow: "reject" }

const owner: OwnerId = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/**
 * The `flows_runs` columns the fence reads, plus this run's running-owner row,
 * written through a throwaway connection to the same file.
 */
const claim = (filename: string) =>
  Effect.scoped(
    Effect.provide(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE flows_runs (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          owner_host_id TEXT,
          owner_pid INTEGER,
          owner_nonce TEXT
        )`
        yield* sql`INSERT INTO flows_runs (run_id, status, owner_host_id, owner_pid, owner_nonce)
          VALUES (${run}, 'running', ${owner.hostId}, ${owner.pid}, ${owner.nonce})`
      }),
      migrated(filename)
    )
  )

const withTempFile = <A, E>(body: (filename: string) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-journal-compaction-"))),
    (directory) => body(join(directory, "journal.sqlite")),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

const migrated = (filename: string) =>
  Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
  )

/**
 * Parks the reader between its event read and its floor read, exactly once.
 *
 * `readPage` reads the page first and the compaction floor second, and the
 * claim under test is that the ordering makes a concurrent truncation visible.
 * This gate sits in that seam: the page rows are already in hand and the floor
 * has not been consulted when the compactor commits.
 */
const parkBetweenPageAndFloor = (
  reached: Deferred.Deferred<void>,
  gate: Deferred.Deferred<void>
): Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient> => {
  let parked = false
  return Layer.merge(
    Layer.effect(
      SqlClient.SqlClient,
      Effect.map(Effect.service(SqlClient.SqlClient), (base) =>
        new Proxy(base, {
          apply(target, thisArgument, argumentsList) {
            const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
            if (parked || typeof statement.compile !== "function") {
              return statement
            }
            const [query] = statement.compile()
            if (!query.includes("FROM flows_journal_events") || !query.includes("seq >")) {
              return statement
            }
            parked = true
            return statement.pipe(
              Effect.tap(() => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(gate))))
            )
          }
        }) as SqlClient.SqlClient)
    ),
    Layer.effect(DurableWriter, Effect.service(DurableWriter))
  )
}

const connection = (
  filename: string,
  decorator?: Layer.Layer<DurableWriter | SqlClient.SqlClient, never, DurableWriter | SqlClient.SqlClient>
) => {
  const layer = SqlJournal.layer(options)
  return Effect.map(
    Layer.build(
      (decorator === undefined ? layer : layer.pipe(Layer.provide(decorator))).pipe(Layer.provide(migrated(filename)))
    ),
    (context) => Context.get(context, Journal) as Service
  )
}

const seed = (journal: Service, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => journal.emitDurableUnfenced(input(index)),
    { discard: true }
  )

describe("SqlJournal reader and compactor on one file", () => {
  it.effect(
    "fails a page read with compacted rather than returning a shortened history",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            yield* claim(filename)

            yield* Effect.scoped(
              Effect.gen(function*() {
                const writer = yield* connection(filename)
                yield* seed(writer, 6)
                yield* writer.checkpoint({ runId: run, seq: 5 as Seq, state: { at: 5 } }, owner)
              })
            )

            const reader = yield* connection(filename, parkBetweenPageAndFloor(reached, gate))
            const compactor = yield* connection(filename)

            // The reader has the full page in hand and has not yet read the
            // floor.
            const reading = yield* Effect.forkChild(
              Effect.exit(reader.entries({ runId: run, limit: 10 })),
              { startImmediately: true }
            )
            yield* Deferred.await(reached)

            // A compactor on its own connection truncates everything below the
            // checkpoint and commits.
            const compacted = yield* compactor.compact({ runId: run }, owner)
            expect(compacted.deleted).toBe(5)
            expect(compacted.checkpointSeq).toBe(5)

            yield* Deferred.succeed(gate, undefined)
            const exit = yield* Fiber.join(reading)

            // The floor read happens after the DELETE committed, so the reader
            // is told to resync rather than handed the rows it read before the
            // truncation.
            expect(exit._tag).toBe("Failure")
            const failure = (exit._tag === "Failure" ? exit.cause.reasons[0] : undefined) as unknown as {
              readonly error: { readonly code: string; readonly checkpointSeq: number }
            }
            expect(failure.error.code).toBe("compacted")
            expect(failure.error.checkpointSeq).toBe(5)
          })
        )
      ),
    30_000
  )

  it.effect(
    "serves a complete page to a cursor at the floor while a compactor commits beneath it",
    () =>
      withTempFile((filename) =>
        Effect.scoped(
          Effect.gen(function*() {
            const reached = yield* Deferred.make<void>()
            const gate = yield* Deferred.make<void>()
            yield* claim(filename)

            yield* Effect.scoped(
              Effect.gen(function*() {
                const writer = yield* connection(filename)
                yield* seed(writer, 7)
                yield* writer.checkpoint({ runId: run, seq: 5 as Seq, state: { at: 5 } }, owner)
              })
            )

            const reader = yield* connection(filename, parkBetweenPageAndFloor(reached, gate))
            const compactor = yield* connection(filename)

            // This reader is already at sequence 4, so the truncation about to
            // commit deletes nothing it still needs.
            const reading = yield* Effect.forkChild(
              Effect.exit(reader.entries({ runId: run, after: 4 as Seq, limit: 10 })),
              { startImmediately: true }
            )
            yield* Deferred.await(reached)
            expect((yield* compactor.compact({ runId: run }, owner)).deleted).toBe(5)
            yield* Deferred.succeed(gate, undefined)

            const exit = yield* Fiber.join(reading)
            // The other permitted outcome: a complete tail, never a gapped or
            // silently truncated one.
            expect(exit._tag).toBe("Success")
            const page = exit._tag === "Success" ? exit.value : undefined
            expect(page?.entries.map((entry) => entry.seq)).toEqual([5, 6])
            expect(page?.hasMore).toBe(false)
          })
        )
      ),
    30_000
  )
})
