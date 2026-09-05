import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const item: Notification = {
  _tag: "human-steer",
  delivery: "steer",
  id: "transaction-steer",
  targetLineageId: "run/root",
  provenance: {
    sourceRunId: "operator",
    sourceLineageId: "operator/root",
    sourceTurn: 1,
    sourceActor: "human:test"
  },
  payload: { body: "A durable instruction" }
}

const boundary = { runId: "run", targetLineageId: "run/root", boundary: "turn", wouldIdle: false }
const rollback = Effect.fail(new Journal.JournalError({ code: "unknown", message: "injected before commit" }))
const withQueue = <A, E>(journal: Journal.Service, effect: Effect.Effect<A, E, NotificationQueue.NotificationQueue>) =>
  effect.pipe(Effect.provide(NotificationQueue.layer.pipe(Layer.provide(Layer.succeed(Journal.Journal, journal)))))

describe("NotificationQueue commit ownership", () => {
  it("does not publish a speculative fold at another journal's commit", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const otherContext = yield* Layer.build(Layer.fresh(TestJournal.layer()))
        const other = Context.get(otherContext, Journal.Journal)
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* journal.transact(Effect.gen(function*() {
              yield* queue.admit("run", item)
              expect(yield* other.transact(queue.pending("run"))).toEqual([item])
              return yield* rollback
            })).pipe(Effect.exit)
            expect(yield* queue.pending("run")).toEqual([])
            expect(yield* queue.admit("run", item)).toMatchObject({ duplicate: false })
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("retries an admission rolled back after its fold and agrees with a fresh queue", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        let failOnce = true
        const wrapped: Journal.Service = {
          ...journal,
          transact: (body) =>
            journal.transact(body.pipe(Effect.tap(() => {
              if (!failOnce) return Effect.void
              failOnce = false
              return rollback
            })))
        }
        yield* withQueue(
          wrapped,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            expect((yield* queue.admit("run", item).pipe(Effect.exit))._tag).toBe("Failure")
            expect(yield* queue.pending("run")).toEqual([])
            const receipt = yield* queue.admit("run", item)
            expect(receipt).toMatchObject({ decision: "admitted", duplicate: false })
            expect(yield* queue.pending("run")).toEqual([item])
          })
        )
        const entries = yield* journal.entries({ runId: JournalEvent.RunId.make("run"), limit: 100 })
        expect(entries.entries).toHaveLength(1)
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            expect(yield* queue.pending("run")).toEqual([item])
            expect(yield* queue.admit("run", item)).toMatchObject({ duplicate: true })
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("does not lose a notification when a promotion rolls back after folding", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        let shouldFail = false
        const wrapped: Journal.Service = {
          ...journal,
          transact: (body) => journal.transact(body.pipe(Effect.tap(() => shouldFail ? rollback : Effect.void)))
        }
        yield* withQueue(
          wrapped,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* queue.admit("run", item)
            shouldFail = true
            expect((yield* queue.drain(boundary).pipe(Effect.exit))._tag).toBe("Failure")
            expect(yield* queue.pending("run")).toEqual([item])
            shouldFail = false
            expect(yield* queue.drain(boundary)).toMatchObject({ duplicate: false, notifications: [item] })
            expect(yield* queue.pending("run")).toEqual([])
          })
        )
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            expect(yield* queue.pending("run")).toEqual([])
            expect(yield* queue.drain(boundary)).toMatchObject({ duplicate: true, notifications: [item] })
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("does not cache an admission when a later enclosing transaction rolls back", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* journal.transact(Effect.gen(function*() {
              yield* queue.admit("run", item)
              expect(yield* queue.pending("run")).toEqual([item])
              return yield* rollback
            })).pipe(Effect.exit)
            expect(yield* queue.pending("run")).toEqual([])
            expect(yield* queue.admit("run", item)).toMatchObject({ duplicate: false })
          })
        )
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            expect(yield* queue.pending("run")).toEqual([item])
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("discards a failed inner admission when the enclosing transaction succeeds", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* withQueue(
          journal,
          Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            yield* journal.transact(Effect.gen(function*() {
              yield* journal.transact(queue.admit("run", item).pipe(Effect.andThen(rollback))).pipe(Effect.exit)
              expect(yield* queue.pending("run")).toEqual([])
            }))
            expect(yield* queue.pending("run")).toEqual([])
            expect(yield* queue.admit("run", item)).toMatchObject({ duplicate: false })
            expect(yield* queue.pending("run")).toEqual([item])
          })
        )
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })
})
