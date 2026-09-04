/**
 * Follow a run's journal from a second process's point of view.
 *
 * The sync protocol is read-only. A follower opens a subscription against a
 * scope and receives the durable history first, then live entries as they
 * commit. Cursors are per run and tolerate sequence holes: `afterSeq` means
 * "entries after this number", never "the next adjacent number".
 *
 * The wiring below is the same one the package's own suites use: a real
 * `SyncServer` over a real SQL journal, connected to a real `SyncClient`
 * through the in-memory socket pair from `@smthrs/sync/test/TestSocket`.
 * Swap the socket for a network transport and the follower code is unchanged.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestSocket from "@smthrs/sync/test/TestSocket"
import * as TestSync from "@smthrs/sync/test/TestSync"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"

export interface Summary {
  readonly caughtUp: ReadonlyArray<string>
  readonly followed: ReadonlyArray<string>
}

const runId = "sync-demo-1" as JournalEvent.RunId
const sourceId = "examples" as JournalEvent.SourceId

const entry = (sourceSeq: number, eventType: string) =>
  new JournalEvent.Input({
    runId,
    sourceId,
    sourceSeq: sourceSeq as JournalEvent.SourceSeq,
    eventType,
    payload: { sourceSeq },
    meta: null
  })

export const main: Effect.Effect<Summary> = Effect.gen(function*() {
  const journal = yield* Journal.Journal

  // History the follower has never seen.
  yield* journal.emitDurableUnfenced(entry(0, "run.started"))
  yield* journal.emitDurableUnfenced(entry(1, "step.recorded"))

  const pair = yield* TestSocket.makePair()
  const follower = yield* TestSync.connect(pair)

  const collected = yield* Stream.runCollect(
    follower.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(3))
  ).pipe(Effect.forkChild({ startImmediately: true }))

  // A live entry committed after the subscription opened.
  yield* journal.emitDurableUnfenced(entry(2, "run.completed"))

  const entries = Array.from(yield* Fiber.join(collected))
  return {
    caughtUp: entries.slice(0, 2).map((committed) => committed.eventType),
    followed: entries.slice(2).map((committed) => committed.eventType)
  }
}).pipe(Effect.provide(TestSync.layerTest), Effect.scoped, Effect.orDie)
