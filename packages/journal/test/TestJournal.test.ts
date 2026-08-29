import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { Journal, type JournalError } from "../src/Journal.ts"
import { type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

describe("TestJournal", () => {
  it.effect("provides defaults when no options are supplied", () =>
    Effect.gen(function*() {
      const receipt = yield* (
        Effect.gen(function*() {
          return yield* (yield* Journal).emitDurableUnfenced({
            runId: "default-run" as RunId,
            sourceId: "default-source" as SourceId,
            eventType: "default",
            payload: {}
          })
        }).pipe(
          Effect.provide(TestJournal.layer()),
          Effect.scoped
        )
      )

      expect(receipt).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })
    }))

  it.effect("honours the supplied admission options", () =>
    Effect.gen(function*() {
      const receipts = yield* (
        Effect.gen(function*() {
          const journal = yield* Journal
          const emit = (index: number) =>
            journal.emitDurableUnfenced({
              runId: "options-run" as RunId,
              sourceId: `source-${index}` as SourceId,
              eventType: "options",
              payload: {}
            })
          return [yield* emit(0), yield* emit(1)]
        }).pipe(
          Effect.provide(TestJournal.layer({ capacity: 8, overflow: "drop-oldest", batchSize: 1 })),
          Effect.scoped
        )
      )

      expect(receipts.map((receipt) => receipt._tag)).toEqual(["Accepted", "Accepted"])
    }))

  it.effect("forwards capacity and every overflow policy to the lossy queue", () =>
    Effect.gen(function*() {
      // `emitDurable` writes straight through the transaction and never touches
      // the admission queue, so the cell above would stay green even if the
      // bundle stopped forwarding `capacity`/`overflow` entirely. `emitLossy` is
      // the only channel that observes them.
      const emitThree = (policy: NonNullable<TestJournal.TestJournalOptions["overflow"]>) =>
        Effect.gen(function*() {
          const journal = yield* Journal
          const emit = (sequence: number) =>
            journal.emitLossy({
              runId: `queue-${policy}` as RunId,
              sourceId: "producer" as SourceId,
              sourceSeq: sequence as SourceSeq,
              eventType: "queued",
              payload: { sequence }
            })
          // Capacity 1: the first admission fills the queue and the second
          // overflows, so the policy decides the second receipt.
          const first = yield* emit(0)
          const second = yield* Effect.exit(emit(1))
          return { first, second }
        }).pipe(
          Effect.provide(TestJournal.layer({ capacity: 1, overflow: policy, batchSize: 1 })),
          Effect.scoped
        )

      const failureOf = (exit: Exit.Exit<unknown, JournalError>): JournalError | undefined => {
        if (!Exit.isFailure(exit)) return undefined
        const reason = exit.cause.reasons[0]!
        return reason._tag === "Fail" ? reason.error : undefined
      }

      const rejected = yield* (emitThree("reject"))
      expect(rejected.first._tag).toBe("Accepted")
      expect(failureOf(rejected.second)?.code).toBe("queue_overflow")

      const newest = yield* (emitThree("drop-newest"))
      expect(newest.first._tag).toBe("Accepted")
      expect(Exit.isSuccess(newest.second) ? newest.second.value : undefined).toMatchObject({
        _tag: "Dropped",
        policy: "drop-newest"
      })

      const oldest = yield* (emitThree("drop-oldest"))
      expect(oldest.first._tag).toBe("Accepted")
      expect(Exit.isSuccess(oldest.second) ? oldest.second.value : undefined).toMatchObject({
        _tag: "Accepted",
        evicted: { policy: "drop-oldest", count: 1 }
      })
    }))
})
