import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = "gapped-run" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (value: number) =>
  new JournalEvent.Entry({
    runId,
    seq: seq(value),
    eventId: `event-${value}`,
    sourceId,
    sourceSeq: sourceSeq(value),
    emittedAtMs: value,
    eventType: "event",
    payload: value,
    meta: null
  })

const makeServer = (entries: ReadonlyArray<JournalEvent.Entry>) =>
  SyncServer.makeLive.pipe(
    Effect.provide(
      Layer.mergeAll(
        Journal.layerNoop({
          stream: ({ afterSequence }) =>
            Stream.fromIterable(entries.filter((entry) => afterSequence === undefined || entry.seq > afterSequence))
        }),
        RunCatalog.layerStatic([runId])
      )
    )
  )

// Non-branch reads are fail-closed; these suites test replication mechanics,
// so they run as the workspace principal.
const asWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provide(effect, SyncPrincipal.layerWorkspace("server-suite"))

describe("SyncServer", () => {
  it.effect("covers legitimate journal gaps and enforces subscription credit", () =>
    Effect.gen(function*() {
      const frames = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer([entry(2), entry(5), entry(8)])
          return yield* server.subscribe({
            scope: { _tag: "Run", runId },
            cursors: [{ runId, afterSeq: seq(0) }],
            credit: 2
          }).pipe(Stream.runCollect)
        })
      )

      expect(Array.from(frames)).toMatchObject([
        { _tag: "Entries", fromSeq: 1, toSeq: 2, entries: [{ seq: 2 }] },
        { _tag: "Entries", fromSeq: 3, toSeq: 5, entries: [{ seq: 5 }] }
      ])
    }))

  // A zero credit has two readings that are indistinguishable on the wire —
  // "open a window of nothing" and "a caller computed its window wrong" — and
  // the second busy-loops a follow that replenishes by resubscribing. It is
  // refused rather than served as an immediately-empty stream.
  it.effect("refuses a subscription whose credit is not a positive integer", () =>
    Effect.gen(function*() {
      const refusals = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer([entry(0)])
          const attempt = (credit: number) =>
            Effect.flip(
              Stream.runCollect(server.subscribe({ scope: { _tag: "Run", runId }, cursors: [], credit }))
            )
          return [yield* attempt(0), yield* attempt(-1), yield* attempt(Number.NaN)] as const
        })
      )

      for (const refusal of refusals) {
        expect(SyncError.is(refusal)).toBe(true)
        expect(refusal.code).toBe("invalid_request")
      }
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SyncProtocol.SubscribeRequest)({
            scope: { _tag: "Run", runId },
            cursors: [],
            credit: 0
          })
        )
      ).toBe(true)
    }))

  // The credit ceiling is enforced on both sides: the wire refuses an
  // over-limit request outright, and an in-process caller is clamped, so no
  // path can pin one server-side fan-out for an unbounded number of frames.
  it.effect("bounds credit above as well as below", () =>
    Effect.gen(function*() {
      const frames = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer([entry(0), entry(1)])
          return yield* Stream.runCollect(
            server.subscribe({
              scope: { _tag: "Run", runId },
              cursors: [],
              credit: SyncProtocol.maxSubscribeCredit * 10
            })
          )
        })
      )

      expect(Array.from(frames)).toHaveLength(2)
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SyncProtocol.SubscribeRequest)({
            scope: { _tag: "Run", runId },
            cursors: [],
            credit: SyncProtocol.maxSubscribeCredit + 1
          })
        )
      ).toBe(true)
    }))
})
