import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import { withCrypto } from "./Sha256.ts"

const owner = {
  hostId: "deferred-test",
  pid: 1,
  nonce: "owner"
}

const TestFlow = Flow.make("DeferredPersistence/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const makeJournal = (events: Array<string>) =>
  (() => {
    const admissions = new Map<string, {
      readonly seq: JournalEvent.Seq
      readonly sourceSeq: JournalEvent.SourceSeq
    }>()
    const record = (input: JournalEvent.Input, channel: string) =>
      Effect.sync(() => {
        const sourceSeq = input.sourceSeq ?? 0 as JournalEvent.SourceSeq
        const key = JSON.stringify([input.runId, input.sourceId, sourceSeq])
        const existing = admissions.get(key)
        if (existing !== undefined) {
          return {
            _tag: "Duplicate" as const,
            ...existing,
            status: "committed" as const
          }
        }
        const row = {
          seq: admissions.size as JournalEvent.Seq,
          sourceSeq
        }
        admissions.set(key, row)
        events.push(`${channel}:${input.eventType}`)
        return {
          _tag: "Accepted" as const,
          ...row
        }
      })
    return Journal.makeNoop({
      emitDurable: (input) => record(input, "emit"),
      emitDurableUnfenced: (input) => record(input, "emit"),
      flush: Effect.sync(() => {
        events.push("flush")
      })
    })
  })()

const build = (
  state: DurableEngineState.Service,
  journal: Journal.Service,
  resumes: Array<string>,
  onResume?: () => void,
  fireRetryPolicy?: DeferredPersistence.FireRetryPolicy
) =>
  DeferredPersistence.make({
    owner,
    journalSource: "deferred-test",
    scheduleResume: (_flowName, executionId, reason) =>
      Effect.sync(() => {
        onResume?.()
        resumes.push(`${executionId}:${reason}`)
      }),
    fireRetryPolicy
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, state),
    Effect.provideService(Journal.Journal, journal)
  )

describe("DeferredPersistence", () => {
  it.effect("keeps the first duplicate or divergent completion", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const events: Array<string> = []
        const resumes: Array<string> = []
        const service = yield* build(state, makeJournal(events), resumes)
        const address = {
          flowName: TestFlow._tag,
          executionId: "duplicate",
          deferredName: "answer"
        }

        yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
        yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
        yield* service.deferredDone({ ...address, exit: Exit.succeed("different") })
        return {
          row: Option.getOrThrow(yield* state.deferred(address)),
          events,
          resumes
        }
      })))

      expect(result.row.exit).toEqual(Exit.succeed("first"))
      expect(result.events).toEqual([
        "emit:flows.engine.deferred-completed",
        "flush",
        "flush",
        "flush"
      ])
      expect(result.resumes).toEqual([
        "duplicate:deferred",
        "duplicate:deferred",
        "duplicate:deferred"
      ])
    }))

  it.effect("makes delivery durable before scheduling a resume", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const events: Array<string> = []
      const resumes: Array<string> = []
      let durableAtResume = false
      const address = {
        flowName: TestFlow._tag,
        executionId: "ordered",
        deferredName: "answer"
      }

      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const service = yield* build(state, makeJournal(events), resumes, () => {
          durableAtResume = events.at(-1) === "flush"
        })
        yield* service.deferredDone({
          ...address,
          exit: Exit.succeed("done"),
          metadata: { correlationId: "opaque" }
        })
      })))

      expect(durableAtResume).toBe(true)
      expect(Option.getOrThrow(yield* withCrypto(state.deferred(address))).metadata).toEqual({
        correlationId: "opaque"
      })
    }))

  it.effect("reads a completion from a fresh persistence instance", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const journal = makeJournal([])
        const first = yield* build(state, journal, [])
        yield* first.deferredDone({
          flowName: TestFlow._tag,
          executionId: "restart",
          deferredName: "answer",
          exit: Exit.succeed("persisted")
        })

        const restarted = yield* build(state, journal, [])
        const instance = FlowEngine.makeInstance(
          TestFlow,
          "restart"
        )
        return yield* restarted.deferredResult(
          DurableDeferred.make("answer", {
            success: Schema.String
          })
        ).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
      })))

      expect(Option.getOrThrow(result)).toEqual(Exit.succeed("persisted"))
    }))

  it.effect("re-arms a future clock after restart and fires its original deadline", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          const journal = makeJournal(events)
          const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })

          yield* Effect.scoped(Effect.gen(function*() {
            const first = yield* build(state, journal, resumes)
            yield* first.scheduleClock(TestFlow, {
              executionId: "clock-run",
              clock
            })
          }))
          yield* TestClock.adjust("5 seconds")

          const restarted = yield* build(state, journal, resumes)
          yield* restarted.sweepDue(TestFlow._tag)
          const before = Option.getOrThrow(
            yield* state.clock({
              flowName: TestFlow._tag,
              executionId: "clock-run",
              clockName: "wake"
            })
          )

          yield* TestClock.adjust("4999 millis")
          yield* Effect.yieldNow
          const pending = Option.getOrThrow(yield* state.clock(before))
          yield* TestClock.adjust("1 millis")
          yield* Effect.yieldNow
          const after = Option.getOrThrow(yield* state.clock(before))
          return { before, pending, after, events, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.before.dueAtMs).toBe(10_000)
      expect(result.pending.completedAtMs).toBeNull()
      expect(result.after.completedAtMs).toBe(10_000)
      expect(result.resumes).toEqual(["clock-run:clock"])
      expect(result.events.filter((event) => event === "emit:flows.engine.clock-scheduled")).toHaveLength(1)
      expect(result.events.filter((event) => event === "emit:flows.engine.deferred-completed")).toHaveLength(1)
    }))

  it.effect("redispatches a clock fire with backoff after a transient journal failure instead of losing the timer", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          // The first two durable emits at fire time die (e.g. SQLITE_BUSY
          // surfaced through the orDie journal path); the third succeeds.
          let failuresRemaining = 0
          let fireFailures = 0
          const base = makeJournal(events)
          const journal = {
            ...base,
            emitDurableUnfenced: (input: JournalEvent.Input) =>
              Effect.suspend(() => {
                if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
                  failuresRemaining--
                  fireFailures++
                  return Effect.die(new Error("transient journal failure"))
                }
                return base.emitDurableUnfenced(input)
              })
          }
          const clock = DurableClock.make({ name: "retry", duration: "10 seconds" })
          const service = yield* build(state, journal as never, resumes)
          yield* service.scheduleClock(TestFlow, { executionId: "retry-run", clock })
          failuresRemaining = 2
          const address = {
            flowName: TestFlow._tag,
            executionId: "retry-run",
            clockName: "retry"
          }

          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          // First fire failed at the journal; without redispatch the timer
          // fiber is dead and the clock row never completes in this process.
          const afterFirstFailure = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("100 millis")
          yield* Effect.yieldNow
          const afterSecondFailure = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("200 millis")
          yield* Effect.yieldNow
          const afterRetry = Option.getOrThrow(yield* state.clock(address))
          return { afterFirstFailure, afterSecondFailure, afterRetry, fireFailures, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.fireFailures).toBe(2)
      expect(result.afterFirstFailure.completedAtMs).toBeNull()
      expect(result.afterSecondFailure.completedAtMs).toBeNull()
      expect(result.afterRetry.completedAtMs).not.toBeNull()
      expect(result.resumes).toEqual(["retry-run:clock"])
    }))

  it.effect("redispatches on a supplied policy instead of the default backoff", () =>
    Effect.gen(function*() {
      // The default ladder starts at 100ms (`defaultFireRetryPolicy`); this
      // composition supplies a flat 5s one instead, so the redispatch that the
      // test above observed after 100ms must not have happened yet at 4999ms.
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          let failuresRemaining = 0
          const base = makeJournal(events)
          const journal = {
            ...base,
            emitDurableUnfenced: (input: JournalEvent.Input) =>
              Effect.suspend(() => {
                if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
                  failuresRemaining--
                  return Effect.die(new Error("transient journal failure"))
                }
                return base.emitDurableUnfenced(input)
              })
          }
          const clock = DurableClock.make({ name: "slow-retry", duration: "10 seconds" })
          const service = yield* build(state, journal as never, resumes, undefined, Schedule.spaced("5 seconds"))
          yield* service.scheduleClock(TestFlow, { executionId: "slow-retry-run", clock })
          failuresRemaining = 1
          const address = {
            flowName: TestFlow._tag,
            executionId: "slow-retry-run",
            clockName: "slow-retry"
          }

          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          yield* TestClock.adjust("4999 millis")
          yield* Effect.yieldNow
          const beforeSuppliedDelay = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("1 millis")
          yield* Effect.yieldNow
          const afterSuppliedDelay = Option.getOrThrow(yield* state.clock(address))
          return { beforeSuppliedDelay, afterSuppliedDelay, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.beforeSuppliedDelay.completedAtMs).toBeNull()
      expect(result.afterSuppliedDelay.completedAtMs).not.toBeNull()
      expect(result.resumes).toEqual(["slow-retry-run:clock"])
    }))

  it.effect("delivers deferred completions and clock fires while the lossy sink failure is latched", () =>
    Effect.gen(function*() {
      // Issue #43: SqlJournal latches `sinkFailure` forever after one lossy
      // writer error, so `flush` fails on every subsequent call while
      // `emitDurable` keeps committing. Durable delivery must survive that.
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          let flushFailures = 0
          const base = makeJournal(events)
          const journal: Journal.Service = {
            ...base,
            flush: Effect.suspend(() => {
              flushFailures++
              return Effect.fail(
                new Journal.JournalError({
                  code: "sink_failed",
                  message: "journal sink failed"
                })
              )
            })
          }
          const service = yield* build(state, journal, resumes)

          const deferredAddress = {
            flowName: TestFlow._tag,
            executionId: "latched-run",
            deferredName: "answer"
          }
          yield* service.deferredDone({
            ...deferredAddress,
            exit: Exit.succeed("still delivered")
          })
          const deferredRow = Option.getOrThrow(yield* state.deferred(deferredAddress))

          const clock = DurableClock.make({ name: "latched", duration: "10 seconds" })
          yield* service.scheduleClock(TestFlow, { executionId: "latched-run", clock })
          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          const clockRow = Option.getOrThrow(
            yield* state.clock({
              flowName: TestFlow._tag,
              executionId: "latched-run",
              clockName: "latched"
            })
          )
          return { deferredRow, clockRow, events, resumes, flushFailures }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      // Every flush attempt failed with the latched sink error...
      expect(result.flushFailures).toBeGreaterThanOrEqual(3)
      // ...yet the durable channel committed and delivery still happened.
      expect(result.deferredRow.exit).toEqual(Exit.succeed("still delivered"))
      expect(result.clockRow.completedAtMs).not.toBeNull()
      expect(result.events).toContain("emit:flows.engine.deferred-completed")
      expect(result.events).toContain("emit:flows.engine.clock-scheduled")
      expect(result.resumes).toEqual(["latched-run:deferred", "latched-run:clock"])
    }))

  it.effect("re-delivers a wake for a completion recorded before registration", () =>
    Effect.gen(function*() {
      const resumes: Array<string> = []
      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: "completion-during-downtime",
          deferredName: "answer",
          exit: Exit.succeed("ready"),
          completedAtMs: 1
        })
        const restarted = yield* build(state, makeJournal([]), resumes)
        yield* restarted.sweepDue(TestFlow._tag)
      })))

      expect(resumes).toEqual(["completion-during-downtime:deferred"])
    }))

  it.effect("uses one stable wake identity across repeated registration sweeps", () =>
    Effect.gen(function*() {
      const sourceIds: Array<string> = []
      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: "historical-completion",
          deferredName: "answer",
          exit: Exit.succeed("ready"),
          completedAtMs: 1
        })
        const service = yield* DeferredPersistence.make({
          owner,
          journalSource: "deferred-test",
          scheduleResume: (_flowName, _executionId, _reason, sourceId) =>
            Effect.sync(() => sourceIds.push(sourceId!))
        }).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, state),
          Effect.provideService(Journal.Journal, makeJournal([]))
        )
        yield* service.sweepDue(TestFlow._tag)
        yield* service.sweepDue(TestFlow._tag)
      })))

      expect(sourceIds).toEqual([
        'deferred-test:wake:["DeferredPersistence/Test","historical-completion","answer"]',
        'deferred-test:wake:["DeferredPersistence/Test","historical-completion","answer"]'
      ])
    }))
})
