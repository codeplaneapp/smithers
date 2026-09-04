import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const runId = "wire-version" as JournalEvent.RunId
const sourceId = "source" as JournalEvent.SourceId
const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("sync protocol compatibility over a socket", () => {
  for (const operation of ["Sync.Read", "Sync.Subscribe"]) {
    for (const version of [undefined, 999]) {
      it.live(`${operation} refuses protocol version ${version}`, () =>
        Effect.scoped(
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: null })
            const pair = yield* TestSocket.makePair()
            pair.faults.installFilter((bytes) =>
              encoder.encode(JSON.stringify(JSON.parse(decoder.decode(bytes)), (_key, value) => {
                if (value?.tag === operation && value.payload) {
                  return { ...value, payload: { ...value.payload, protocolVersion: version } }
                }
                return value
              }))
            )
            const server = yield* SyncServer.SyncServer
            const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
              ...server,
              read: operation === "Sync.Subscribe"
                ? () => Effect.succeed({ entries: [], cursors: [], done: true })
                : server.read
            }))
            const failure = yield* Effect.flip(
              client.subscribe({
                cursors: [],
                scope: { _tag: "Run", runId }
              }).pipe(Stream.take(1), Stream.runDrain)
            )
            expect(failure).toMatchObject({ code: "protocol_violation" })
            expect(yield* client.cursors).toEqual([])
          }).pipe(Effect.provide(TestSync.layerTest))
        ))
    }
  }

  for (const bootstrap of [true, false]) {
    it.live(`refuses missing generations in ${bootstrap ? "read pages" : "live frames"}`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: null })
          const pair = yield* TestSocket.makePair()
          pair.faults.installFilter((bytes) =>
            encoder.encode(JSON.stringify(
              JSON.parse(decoder.decode(bytes)),
              (key, value) => key === "generation" ? undefined : value
            ))
          )
          const server = yield* SyncServer.SyncServer
          const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
            ...server,
            read: bootstrap ? server.read : () => Effect.succeed({ entries: [], cursors: [], done: true })
          }))
          const failure = yield* Effect.flip(
            client.subscribe({ cursors: [], scope: { _tag: "Run", runId } })
              .pipe(Stream.take(1), Stream.runDrain)
          )
          expect(failure).toMatchObject({ code: "protocol_violation" })
          expect(yield* client.cursors).toEqual([])
        }).pipe(Effect.provide(TestSync.layerTest))
      ))
  }
})

for (const bootstrap of [true, false]) {
  it.live(`accepts persisted generation-zero request cursors (${bootstrap ? "read" : "live"})`, () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        for (let n = 0; n < 2; n++) {
          yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: n })
        }
        const pair = yield* TestSocket.makePair()
        const server = yield* SyncServer.SyncServer
        const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
          ...server,
          read: bootstrap ? server.read : () => Effect.succeed({ entries: [], cursors: [], done: true })
        }))
        const options = {
          scope: { _tag: "Run", runId } as const,
          cursors: [{ runId, afterSeq: 0 as JournalEvent.Seq }]
        }
        const first = yield* client.subscribe(options).pipe(Stream.take(1), Stream.runCollect)
        expect(first.map((entry) => entry.seq)).toEqual([1])
        yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: 2 })
        const second = yield* client.subscribe(options).pipe(Stream.take(1), Stream.runCollect)
        expect(second.map((entry) => entry.seq)).toEqual([2])
        expect(yield* client.cursors).toEqual([{ runId, afterSeq: 2, generation: 0 }])
      }).pipe(Effect.provide(TestSync.layerTest))
    ))
}
