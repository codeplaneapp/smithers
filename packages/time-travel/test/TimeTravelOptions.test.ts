import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Ownership from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { layerWith, TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const row: RunStore.RunRow = {
  runId: "run",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
}

describe("TimeTravel rewind options", () => {
  for (const pageSize of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it.effect(`rejects pageSize ${String(pageSize)} before claim, audit, or truncation`, () =>
      Effect.gen(function*() {
        const store = MemoryTimeTravelStore.make({
          records: [
            {
              runId: "run",
              seq: 0,
              eventId: "base",
              lineageId: "run/root",
              payload: { eventType: "base", payload: {}, meta: { lineageId: "run/root" } }
            },
            {
              runId: "run",
              seq: 1,
              eventId: "suffix",
              lineageId: "run/root",
              payload: { eventType: "suffix", payload: {}, meta: { lineageId: "run/root" } }
            }
          ]
        })
        const before = store.state()
        let claims = 0
        let pages = 0
        const entries: ReadonlyArray<JournalEvent.Entry> = store.state().records.map((record) => ({
          runId: record.runId as JournalEvent.RunId,
          seq: record.seq as JournalEvent.Seq,
          eventId: record.eventId,
          sourceId: "options" as JournalEvent.SourceId,
          sourceSeq: record.seq as JournalEvent.SourceSeq,
          emittedAtMs: record.seq,
          eventType: "test",
          payload: {},
          meta: { lineageId: record.lineageId }
        }))
        const journal = Journal.makeNoop({
          entries: ({ after, limit }) =>
            Effect.sync(() => {
              pages += 1
              const remaining = entries.filter((entry) => entry.seq > (after ?? -1))
              const page = remaining.slice(0, Math.max(0, Math.min(limit, remaining.length)))
              return { entries: page, hasMore: remaining.length > page.length }
            })
        })
        const runs = RunStore.makeNoop({
          get: () => Effect.succeed(row),
          claim: (_runId, _expected, _owner, nowMs) =>
            Effect.sync(() => {
              claims += 1
              return { _tag: "Claimed" as const, claimedAtMs: nowMs }
            }),
          activate: () => Effect.succeed({ _tag: "Activated" as const }),
          transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
        })
        const layer = TimeTravel.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TimeTravelStore)(store),
              Layer.succeed(RunStore.RunStore)(runs),
              Layer.succeed(Journal.Journal)(journal),
              Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
              CacheStore.layerNoop()
            )
          )
        )
        const exit = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              return yield* Effect.exit(
                timeTravel.rewind(
                  { runId: "run", frame: { lineageId: "run/root", seq: 0 } },
                  { pageSize }
                )
              )
            }).pipe(Effect.provide(layer))
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(claims).toBe(0)
        expect(pages).toBe(0)
        expect(store.state()).toEqual(before)
      }))
  }
})

/**
 * Startup recovery is wiring, so the shipped composition has to be able to
 * make progress on its own: a rewind interrupted by a crash leaves the run
 * `running` under the dead incarnation's owner, and with no way to answer "is
 * that owner still there" every build refused the audit forever.
 */
describe("TimeTravel recovery liveness", () => {
  const stranger: Ownership.OwnerId = { hostId: "dead-host", pid: 7, nonce: "dead-incarnation" }

  const crashedAudit = {
    id: "audit",
    runId: "run",
    frame: { lineageId: "run/root", seq: 0 },
    status: "in_progress" as const,
    detail: {
      version: 1,
      phase: "archive_committed",
      originalStatus: "suspended",
      suffixCount: 1,
      suffixTailSeq: 1,
      warnings: [],
      cancelledChildren: []
    }
  }

  const recovered = (
    runs: RunStore.Service,
    options?: { readonly isAlive: Ownership.LivenessCheck }
  ) =>
    Effect.gen(function*() {
      // Past the heartbeat staleness window, so the default lease check has
      // something to conclude: the crashed incarnation stopped renewing.
      yield* TestClock.adjust("1 minute")
      const store = MemoryTimeTravelStore.make()
      yield* store.writeAudit(crashedAudit)
      const composed = (options === undefined ? TimeTravel.layer : layerWith(options)).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TimeTravelStore)(store),
            Layer.succeed(RunStore.RunStore)(runs),
            Layer.succeed(Journal.Journal)(
              Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
            ),
            Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
            CacheStore.layerNoop()
          )
        )
      )
      yield* Effect.scoped(Effect.provide(Effect.void, composed))
      return store.state().audits
    })

  const runningRow = (owner: Ownership.OwnerId | null, heartbeatAtMs: number | null): RunStore.RunRow => ({
    ...row,
    status: "running",
    owner,
    heartbeatAtMs
  })

  it.effect("steals a crashed rewind's run from an owner whose lease expired", () =>
    Effect.gen(function*() {
      const evidence: Array<Ownership.LivenessEvidence> = []
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(stranger, 0)),
          steal: (_runId, _expected, _claimant, nowMs, supplied) =>
            Effect.sync(() => {
              evidence.push(supplied)
              return { _tag: "Claimed" as const, claimedAtMs: nowMs }
            }),
          activate: () => Effect.succeed({ _tag: "Activated" as const }),
          transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
        })
      )

      // `lease-expired` is the only host-neutral kind, and it is the one
      // `RunStore.steal` re-verifies for itself in the same write.
      expect(evidence.map((item) => item.kind)).toEqual(["lease-expired"])
      expect(evidence[0]?.expectedOwner).toEqual(stranger)
      expect(audits[0]).toMatchObject({ status: "completed" })
    }))

  it.effect("leaves the audit recoverable when a supplied probe says the owner is alive", () =>
    Effect.gen(function*() {
      let steals = 0
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(stranger, 0)),
          steal: () =>
            Effect.sync(() => {
              steals += 1
              return { _tag: "Claimed" as const, claimedAtMs: 0 }
            })
        }),
        { isAlive: () => Effect.succeed(true) }
      )

      expect(steals).toBe(0)
      expect(audits[0]).toMatchObject({ status: "in_progress" })
    }))

  it.effect("declines to produce evidence about a running row that records no owner", () =>
    Effect.gen(function*() {
      let steals = 0
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(null, null)),
          steal: () =>
            Effect.sync(() => {
              steals += 1
              return { _tag: "Claimed" as const, claimedAtMs: 0 }
            })
        })
      )

      expect(steals).toBe(0)
      expect(audits[0]).toMatchObject({ status: "in_progress" })
    }))
})
