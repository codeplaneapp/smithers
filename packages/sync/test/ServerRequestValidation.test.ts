import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Schema, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = "request-validation" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = (sequence: number) =>
  new JournalEvent.Entry({
    runId,
    seq: seq(sequence),
    eventId: `request-validation-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

describe("SyncServer request validation", () => {
  it.effect("pins duplicate cursors as first-wins for reads but last-write for response state", () =>
    Effect.gen(function*() {
      const observedAfter: Array<JournalEvent.Seq | undefined> = []
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({
            scope: { _tag: "Run", runId },
            cursors: [
              { runId, afterSeq: seq(0) },
              { runId, afterSeq: seq(2) }
            ],
            limit: 10
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after }) => {
                  observedAfter.push(after)
                  return Effect.succeed({ entries: [entry(1), entry(2)], hasMore: false })
                }
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("validation-suite")
            )
          )
        )
      )

      // CONTRACT: malformed duplicate cursors currently diverge: cursorOf uses
      // the first item, while the response Map was initialized by the last one.
      expect(observedAfter).toEqual([0])
      expect(response.entries.map((value) => value.seq)).toEqual([1, 2])
      expect(response.cursors).toEqual([{ runId, afterSeq: 2 }])
    }))

  it.effect("pins the absence of server-side upper bounds for limit and credit", () =>
    Effect.gen(function*() {
      const oversized = 1_000_000
      const readRequest = Schema.decodeUnknownSync(SyncProtocol.ReadRequest)({
        scope: { _tag: "Run", runId },
        cursors: [],
        limit: oversized
      })
      const subscribeRequest = Schema.decodeUnknownSync(SyncProtocol.SubscribeRequest)({
        scope: { _tag: "Run", runId },
        cursors: [],
        credit: oversized
      })
      let receivedLimit = 0
      const result = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const page = yield* server.read(readRequest)
          const frames = yield* Stream.runCollect(server.subscribe(subscribeRequest))
          return { frames: Array.from(frames), page }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ limit }) => {
                  receivedLimit = limit
                  return Effect.succeed({ entries: [entry(0)], hasMore: false })
                },
                stream: () => Stream.succeed(entry(0))
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("validation-suite")
            )
          )
        )
      )

      // CONTRACT: the wire schemas require non-negative integers but impose no
      // memory/fan-out maximum, and the server forwards the requested values.
      expect(readRequest.limit).toBe(oversized)
      expect(subscribeRequest.credit).toBe(oversized)
      expect(receivedLimit).toBe(oversized)
      expect(result.page.entries).toHaveLength(1)
      expect(result.frames).toHaveLength(1)
    }))
})
