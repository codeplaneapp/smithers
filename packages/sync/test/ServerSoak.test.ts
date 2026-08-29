/**
 * Multi-subscriber consistency and retained-state budgets.
 *
 * Every other sync test collects a handful of frames from one subscriber and
 * terminates immediately, so per-subscriber state that is never released — the
 * unbounded in-process-index class that has already produced two findings —
 * leaves the whole suite green. These tests observe the release side directly:
 * how many journal streams stay open after their subscriptions end, and how
 * much heap a long fan-out soak retains.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: string, sequence: number) =>
  new JournalEvent.Entry({
    runId: runId(id),
    seq: seq(sequence),
    eventId: `${id}-${sequence}`,
    sourceId: sourceId("source"),
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: { index: sequence, text: "x".repeat(256) },
    meta: null
  })

interface Tracker {
  open: number
  peak: number
  opened: number
}

/**
 * A journal whose per-run streams report when they are attached and released,
 * so a subscription that outlives its consumer is observable.
 */
const trackedJournal = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>, tracker: Tracker) =>
  Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) => {
      const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
      const page = all.slice(0, limit)
      return Effect.succeed({ entries: page, hasMore: page.length < all.length })
    },
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.fromIterable(
        (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
      ).pipe(
        Stream.onStart(
          Effect.sync(() => {
            tracker.open += 1
            tracker.opened += 1
            tracker.peak = Math.max(tracker.peak, tracker.open)
          })
        ),
        Stream.ensuring(
          Effect.sync(() => {
            tracker.open -= 1
          })
        )
      )
  } as any)

const workspace = (runs: number, perRun: number) => {
  const byRun: Record<string, ReadonlyArray<JournalEvent.Entry>> = {}
  const ids: Array<JournalEvent.RunId> = []
  for (let run = 0; run < runs; run++) {
    const id = `run-${run}`
    byRun[id] = Array.from({ length: perRun }, (_, index) => entry(id, index))
    ids.push(runId(id))
  }
  return { byRun, ids }
}

// Every soak is bounded by cycle count; a wall-clock limit only measures
// machine load, which the package-wide `testTimeout` budgets for.
describe("SyncServer fan-out budgets", () => {
  it.effect("delivers the identical frame sequence to every concurrent subscriber", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(3, 4)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      const collected = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Effect.all(
            Array.from({ length: 5 }, () =>
              Stream.runCollect(
                server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 12 })
              )),
            { concurrency: "unbounded" }
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      const shapes = collected.map((frames) =>
        Array.from(frames)
          .map((frame) => frame._tag === "Entries" ? `${frame.runId}:${frame.toSeq}` : frame._tag)
          .sort()
      )
      // Every subscriber sees the whole workspace, and sees exactly the same
      // thing: no subscriber may be starved or served a divergent view.
      expect(shapes[0]).toHaveLength(12)
      for (const shape of shapes) {
        expect(shape).toEqual(shapes[0])
      }
      // Five subscribers really did hold five independent fan-outs open.
      expect(tracker.peak).toBeGreaterThanOrEqual(5)
    }))

  it.effect("releases every per-subscriber journal stream when its subscription ends", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(4, 3)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          // Two hundred subscribe/complete cycles: any per-subscription state
          // that is never released shows up as a monotonically rising `open`.
          for (let cycle = 0; cycle < 200; cycle++) {
            yield* Stream.runDrain(
              server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 6 })
            )
          }
        }).pipe(
          Effect.provide(Layer.mergeAll(
            trackedJournal(byRun, tracker),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("soak-suite")
          )),
          Effect.scoped
        )
      )

      expect(tracker.opened).toBeGreaterThanOrEqual(200)
      expect(tracker.open).toBe(0)
      expect(tracker.peak).toBeLessThanOrEqual(2 * ids.length)
    }))

  it.effect("keeps retained heap bounded across a subscriber soak", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(4, 25)
      const tracker: Tracker = { open: 0, opened: 0, peak: 0 }
      const layers = Layer.mergeAll(
        trackedJournal(byRun, tracker),
        RunCatalog.layerStatic(ids),
        SyncPrincipal.layerWorkspace("soak-suite")
      )
      const soak = (cycles: number) =>
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          for (let cycle = 0; cycle < cycles; cycle++) {
            yield* Effect.all(
              Array.from({ length: 5 }, () =>
                Stream.runDrain(
                  server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 40 })
                )),
              { concurrency: "unbounded" }
            )
          }
        }).pipe(Effect.provide(layers), Effect.scoped)

      // Warm up first so the measurement excludes one-time allocation.
      yield* (soak(20))
      const gc = (globalThis as { gc?: () => void }).gc
      gc?.()
      const before = process.memoryUsage().heapUsed
      yield* (soak(200))
      gc?.()
      const after = process.memoryUsage().heapUsed

      // 200 cycles x 5 subscribers x 4 runs x 25 entries: per-subscriber state
      // that is retained rather than released grows this by tens of megabytes.
      // The budget is deliberately loose — it fails on a leak, not on noise.
      expect(after - before).toBeLessThan(64 * 1024 * 1024)
      expect(tracker.open).toBe(0)
    }))
})
