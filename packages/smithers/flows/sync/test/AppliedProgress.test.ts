import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import type * as Protocol from "../src/SyncProtocol.ts"

const runId = "application-progress" as JournalEvent.RunId
const scope = { _tag: "Run", runId } as const
const entries = [0, 1].map((seq) =>
  new JournalEvent.Entry({
    runId,
    seq: seq as JournalEvent.Seq,
    eventId: `event-${seq}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType: "increment",
    payload: seq + 1,
    meta: null
  })
)
const make = () =>
  SyncClient.make({
    client: {
      "Sync.Read": (request: Protocol.ReadRequest) =>
        Effect.succeed({
          entries: entries.filter((entry) => entry.seq > (request.cursors[0]?.afterSeq ?? -1)),
          cursors: [{ generation: 0, runId, afterSeq: 1 as JournalEvent.Seq }],
          done: true
        }),
      "Sync.Subscribe": () => Stream.never
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  })
const cursor = (afterSeq: number) => [{ generation: 0, runId, afterSeq }]

describe("distinct delivered and applied progress", () => {
  it.effect("does not acknowledge delivery-only data or skip it for a later applying subscription", () =>
    Effect.gen(function*() {
      const client = yield* make()
      yield* client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runDrain)
      expect(yield* client.progress).toEqual({
        delivered: { _tag: "Delivered", cursors: cursor(1) },
        applied: { _tag: "Applied", cursors: [] }
      })
      let total = 0
      yield* client.subscribe({
        scope,
        cursors: [],
        apply: (entry) =>
          Effect.sync(() => {
            total += Number(entry.payload)
          })
      })
        .pipe(Stream.take(2), Stream.runDrain)
      expect(total).toBe(3)
      expect((yield* client.progress).applied).toEqual({ _tag: "Applied", cursors: cursor(1) })
      expect(yield* SyncClient.makeNoop().progress).toEqual({
        delivered: { _tag: "Delivered", cursors: [] },
        applied: { _tag: "Applied", cursors: [] }
      })
    }))

  it.effect("keeps the failed entry unapplied and retries it", () =>
    Effect.gen(function*() {
      const client = yield* make()
      const error = new SyncError({ code: "unknown", message: "consumer transaction rolled back" })
      const applied: Array<number> = []
      expect(
        yield* Effect.flip(
          client.subscribe({
            scope,
            cursors: [],
            apply: (entry) =>
              entry.seq === 1
                ? Effect.fail(error) :
                Effect.sync(() => {
                  applied.push(entry.seq)
                })
          }).pipe(Stream.runDrain)
        )
      ).toBe(error)
      expect((yield* client.progress).applied.cursors).toEqual(cursor(0))
      yield* client.subscribe({
        scope,
        cursors: [],
        apply: (entry) =>
          Effect.sync(() => {
            applied.push(entry.seq)
          })
      })
        .pipe(Stream.take(1), Stream.runDrain)
      expect(applied).toEqual([0, 1])
      expect((yield* client.progress).applied.cursors).toEqual(cursor(1))
    }))

  it.effect("does not acknowledge an interrupted application", () =>
    Effect.gen(function*() {
      const client = yield* make()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* client.subscribe({
        scope,
        cursors: [],
        apply: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      }).pipe(Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      expect(yield* client.progress).toEqual({
        delivered: { _tag: "Delivered", cursors: [] },
        applied: { _tag: "Applied", cursors: [] }
      })
    }))
})
