import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Layer, Logger } from "effect"
import { describe, expect, it } from "vitest"
import { layerJournalForwarding } from "../src/JournalLogger.ts"

const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program.pipe(Effect.scoped))

describe("JournalLogger", () => {
  it("forwards versioned records without changing the logged effect", async () => {
    const result = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("hello")
        yield* Effect.sleep("10 millis")
        yield* journal.flush
        return yield* journal.entries({ runId: "obs-run" as JournalEvent.RunId, limit: 10 })
      }).pipe(
        // One journal layer value, provided once: each `TestJournal.layer()`
        // call opens its own `:memory:` database, so building two of them would
        // forward into a different database than the assertion reads.
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: "obs-run" }), TestJournal.layer()))
      )
    )

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.eventType).toBe("telemetry.log")
    expect(result.entries[0]?.payload).toMatchObject({ version: 1, level: "Info", message: ["hello"] })
  })

  it("drops when full and swallows journal failures", async () => {
    const result = await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("does not fail")
        // The forwarder is a forked worker, so the failing `emitLossy` only
        // runs if the scope stays open long enough for it to drain the queue.
        yield* Effect.sleep("20 millis")
        return "ok"
      }).pipe(
        Effect.provide(
          Layer.provide(layerJournalForwarding({ runId: "drop-run", capacity: 1 }), Journal.layerNoop())
        )
      )
    )
    expect(result).toBe("ok")
  })

  it("preserves scope interruption while a journal write is in flight", async () => {
    const entered = Deferred.makeUnsafe<void>()
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("closing")
        yield* Deferred.await(entered)
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: "interrupt-run" }),
            Journal.layerNoop({
              emitLossy: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            })
          )
        )
      )
    )
  })

  it("keeps the ambient loggers when asked to merge with them", async () => {
    const seen: Array<unknown> = []
    const ambient = Logger.make<unknown, void>((options) => {
      seen.push(options.message)
    })
    await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("merged")
        yield* Effect.sleep("10 millis")
        yield* journal.flush
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            layerJournalForwarding({ runId: "obs-merge", mergeWithExisting: true }),
            Layer.merge(TestJournal.layer(), Logger.layer([ambient], { mergeWithExisting: false }))
          )
        )
      )
    )

    expect(seen).toEqual([["merged"]])
  })
})
