/**
 * What bounds a subscription in TIME and in the run set it covers: the signed
 * expiry of the credential that opened it, and the catalog it reconciles
 * against on every round.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "lifetime-branch" as BranchProtocol.BranchId
const branchRun = BranchProtocol.branchRunId(branchId)
const seq = (value: number) => value as JournalEvent.Seq

const entry = (runId: JournalEvent.RunId, sequence: number) =>
  new JournalEvent.Entry({
    runId,
    seq: seq(sequence),
    eventId: `${runId}-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

const shareLayer = BranchShare.layerHmac({ secret: Redacted.make("lifetime-secret") })

describe("subscription lifetime", () => {
  // A signed expiry is this package's only revocation mechanism, and a
  // subscription is authorized ONCE, at open. Without a deadline on the
  // stream, the holder of an expired share link kept reading for as long as
  // it declined to disconnect, and a quiet stream never re-authorized at all.
  it.effect("ends a branch subscription with unauthorized when its capability expires", () =>
    Effect.gen(function*() {
      // Opening the subscription verifies the capability through Web Crypto,
      // which is asynchronous. Advancing the clock before that resolves would
      // test the OPENING refusal instead of the expiry of an open stream, so
      // the journal stream reports when it is attached and the clock does not
      // move until then.
      const attached = yield* Deferred.make<void>()
      const failure = yield* (
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            access: "read",
            branchId,
            capabilityId: "lifetime-cap",
            ttlMs: 1_000
          })
          const server = yield* SyncServer.makeLive
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                server.subscribe({
                  protocolVersion: 1,
                  capability,
                  credit: 4096,
                  cursors: [],
                  scope: { _tag: "Run", runId: branchRun }
                })
              )
            ),
            { startImmediately: true }
          )
          yield* Deferred.await(attached)
          // The stream is quiet: nothing arrives, nothing is acknowledged, and
          // the only thing that can end it is the expiry.
          yield* TestClock.adjust("2 seconds")
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                stream: () => Stream.onStart(Stream.never, Deferred.succeed(attached, undefined))
              }),
              RunCatalog.layerStatic([branchRun]),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect(SyncError.is(failure)).toBe(true)
      expect(failure.code).toBe("unauthorized")
      expect(failure.message).toContain("expired")
    }))

  // An in-process owner presented no credential, so nothing can expire under
  // it and the stream must not acquire a deadline it never agreed to.
  it.effect("never expires a subscription opened by an in-process owner", () =>
    Effect.gen(function*() {
      const engineRun = "lifetime-engine" as JournalEvent.RunId
      const frames = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const collected = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.take(
                server.subscribe({
                  protocolVersion: 1,
                  credit: 4096,
                  cursors: [],
                  scope: { _tag: "Run", runId: engineRun }
                }),
                1
              )
            ),
            { startImmediately: true }
          )
          yield* TestClock.adjust("10 minutes")
          return yield* Fiber.join(collected)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ stream: () => Stream.succeed(entry(engineRun, 0)) }),
              RunCatalog.layerStatic([engineRun]),
              SyncPrincipal.layerWorkspace("in-process-owner")
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect(Array.from(frames)).toHaveLength(1)
    }))

  // The header's expiry travels with the identity, so a workspace-scoped
  // subscription is bounded by the credential that authenticated it.
  it.effect("ends a workspace subscription when the workspace principal's credential expires", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } })
              )
            ),
            { startImmediately: true }
          )
          yield* TestClock.adjust("2 seconds")
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) }),
              RunCatalog.layerStatic([]),
              Layer.succeed(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("expiring", 1_000))
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect((failure as SyncError).code).toBe("unauthorized")
    }))

  // A workspace subscription discovers runs AFTER it opens: reconciliation
  // admits a branch the catalog names later, under a capability whose expiry
  // was not part of the deadline the subscription opened with. Reducing that
  // admission to a yes threw the expiry away, so a branch found this way
  // streamed for as long as the subscription lived: the exact revocation hole
  // the deadline exists to close, reached by the one door still open.
  it.live("ends a subscription when a branch admitted after it opened expires", () =>
    Effect.gen(function*() {
      const listed = new Set<JournalEvent.RunId>()
      const served: Array<string> = []
      const outcome = yield* (
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            access: "read",
            branchId,
            capabilityId: "late-cap",
            ttlMs: 2_000
          })
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 25 })
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                Stream.tap(
                  server.subscribe({
                    protocolVersion: 1,
                    capability,
                    credit: 4096,
                    cursors: [],
                    scope: { _tag: "Workspace" }
                  }),
                  (frame) =>
                    Effect.sync(() => {
                      if (frame._tag === "Entries") {
                        for (const value of frame.entries) served.push(`${value.runId}:${value.seq}`)
                      }
                    })
                )
              )
            ),
            { startImmediately: true }
          )
          // The branch appears while the subscription is live and inside its
          // capability's window, so reconciliation is what admits it and the
          // next round serves it.
          listed.add(branchRun)
          yield* Effect.sleep("500 millis")
          const inWindow = [...served]
          // Now past the capability's own expiry.
          return [inWindow, yield* Fiber.join(following)] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) => Effect.succeed({ entries: [entry(runId, 0)], hasMore: false })
              }),
              Layer.succeed(
                RunCatalog.RunCatalog,
                RunCatalog.make({ changes: Stream.empty, list: Effect.sync(() => Array.from(listed)) })
              ),
              shareLayer,
              SyncPrincipal.layerWorkspace("late-branch-owner")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const [inWindow, failure] = outcome._tag === "Some" ? outcome.value : [[], undefined]
      // The branch WAS served inside its window, so the case is about expiry
      // and not about the run never becoming visible.
      expect(inWindow).toContain(`${branchRun}:0`)
      expect(failure !== undefined && SyncError.is(failure)).toBe(true)
      expect((failure as SyncError).code).toBe("unauthorized")
      expect((failure as SyncError).message).toContain("expired")
    }))
})

describe("workspace tail catalog reconciliation", () => {
  /** A catalog whose run set the test moves under a live subscription. */
  const mutable = (initial: ReadonlyArray<JournalEvent.RunId>) => {
    const listed = new Set(initial)
    return {
      catalog: RunCatalog.make({
        // `changes` is deliberately empty: the reconciliation must not depend
        // on a notification arriving, because both shipped catalogs publish
        // through a SLIDING feed that drops the oldest under load.
        changes: Stream.empty,
        list: Effect.sync(() => Array.from(listed))
      }),
      listed
    }
  }

  const runs = (count: number) =>
    Array.from({ length: count }, (_, index) => `reconcile-${index}` as JournalEvent.RunId)

  it.live("serves a run the catalog gains while the subscription is live, with no announcement", () =>
    Effect.gen(function*() {
      const [first, second] = runs(2)
      const { catalog, listed } = mutable([first!])
      const served = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 50 })
          const collected = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.take(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } }),
                2
              )
            ),
            { startImmediately: true }
          )
          listed.add(second!)
          return yield* Fiber.join(collected)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) => Effect.succeed({ entries: [entry(runId, 0)], hasMore: false })
              }),
              Layer.succeed(RunCatalog.RunCatalog, catalog),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(served._tag).toBe("Some")
      const frames = served._tag === "Some" ? Array.from(served.value) : []
      const ids = frames.map((frame) => frame._tag === "Entries" ? frame.runId : "")
      expect(new Set(ids)).toEqual(new Set([first, second]))
    }))

  it.live("stops querying a run the catalog stops naming", () =>
    Effect.gen(function*() {
      const [kept, collected] = runs(2)
      // A branch run with no `BranchShare` in scope is closed to this request,
      // so it enters the round's excluded set. Retention must drop it from
      // there too, or the set grows for the life of the subscription.
      const closed = BranchProtocol.branchRunId("reconcile-branch" as BranchProtocol.BranchId)
      const { catalog, listed } = mutable([kept!, collected!, closed])
      const reads: Array<JournalEvent.RunId> = []
      const outcome = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 10 })
          const following = yield* Effect.forkChild(
            Stream.runDrain(
              server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } })
            ),
            { startImmediately: true }
          )
          yield* Effect.sleep("100 millis")
          // Retention collecting a run is exactly "the read stops naming it".
          listed.delete(collected!)
          listed.delete(closed)
          // Let any round already in flight finish before the window opens,
          // so this observes steady state rather than the removal's own tick.
          yield* Effect.sleep("100 millis")
          reads.length = 0
          yield* Effect.sleep("200 millis")
          yield* Fiber.interrupt(following)
          return [...reads]
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) =>
                  Effect.sync(() => {
                    reads.push(runId)
                    return { entries: [], hasMore: false }
                  })
              }),
              Layer.succeed(RunCatalog.RunCatalog, catalog),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const observed = outcome._tag === "Some" ? outcome.value : []
      // Rounds keep visiting the run that is still listed...
      expect(observed).toContain(kept)
      // ...and never the one the catalog stopped naming.
      expect(observed).not.toContain(collected)
      expect(observed).not.toContain(closed)
    }))

  // `tail` used to recurse on itself while the journal reported more, so a run
  // that stayed one page behind never released its `flatMap` slot: with the
  // bound saturated by such runs the round never completed and the runs behind
  // them were never attached at all.
  it.live("serves a cold run behind a run that is permanently a page behind", () =>
    Effect.gen(function*() {
      const hot = "reconcile-hot" as JournalEvent.RunId
      const cold = "reconcile-cold" as JournalEvent.RunId
      const served = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency: 1, tailIntervalMs: 10 })
          return yield* Stream.runCollect(
            Stream.take(
              Stream.filter(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } }),
                (frame) => frame._tag === "Entries" && frame.runId === cold
              ),
              1
            )
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after, runId }) =>
                  runId === hot
                    // Always progressing, always more: the shape that pinned a
                    // slot forever.
                    ? Effect.succeed({ entries: [entry(hot, (after ?? -1) + 1)], hasMore: true })
                    : Effect.succeed({
                      entries: after === undefined ? [entry(cold, 0)] : [],
                      hasMore: false
                    })
              }),
              RunCatalog.layerStatic([cold, hot]),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(served._tag).toBe("Some")
    }))
})
