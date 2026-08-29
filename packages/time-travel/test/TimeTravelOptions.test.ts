import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
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
