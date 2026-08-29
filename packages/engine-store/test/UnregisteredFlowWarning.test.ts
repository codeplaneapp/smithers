import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #62: the #39 reclaim wakes released rows through `drive()`, but
 * `drive()` used to return silently when the run's flow was not registered in
 * the sweeping process — a released run whose flow had not (yet, or ever)
 * been registered was swept every heartbeat and silently dropped, with no
 * log, metric, or health signal distinguishing this from a healthy sweep.
 * The driver must emit a structured warning (once per run) and leave the row
 * parked so a later registration still reclaims it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Logger from "effect/Logger"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("UnregisteredFlowWarning/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "unregistered-host", pid: 1, nonce },
    journalSource: "unregistered-flow-warning",
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  ) as Effect.Effect<
    A,
    E,
    Exclude<R, Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | Scope.Scope>
  >

/** Interrupts a run mid-action via driver-scope close (process shutdown). */
const releaseMidAction = (executionId: string) =>
  Effect.gen(function*() {
    const driverScope = yield* Scope.make()
    const driver = yield* makeDriver("owner-1").pipe(Scope.provide(driverScope))
    const started = yield* Latch.make(false)
    yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
    yield* driver.execute(TestFlow, {
      executionId,
      payload: {},
      discard: true
    }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Latch.await(started)
    yield* Scope.close(driverScope, Exit.void)
  })

describe("unregistered-flow reclaim is loud, not silent (issue #62)", () => {
  it.effect("warns once per run while the flow is unregistered and reclaims after registration", () =>
    Effect.gen(function*() {
      const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
      const capture = Logger.make((options) => {
        logs.push({ message: options.message, logLevel: options.logLevel })
      })

      const result = yield* withCrypto(provideJournal(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const state = yield* DurableEngineState.DurableEngineState
          yield* releaseMidAction("unregistered-release")

          // A fresh worker over the same store that has NOT registered the flow:
          // its sweep re-drives the released row every heartbeat.
          const successorScope = yield* Scope.make()
          yield* makeDriver("owner-2").pipe(Scope.provide(successorScope))
          yield* TestClock.adjust(3 * Duration.toMillis(Ownership.heartbeatInterval))

          const warningsWhileUnregistered = logs.filter((entry) => String(entry.message).includes("not registered"))
          const rowWhileUnregistered = yield* store.get("unregistered-release")
          const waitingWhileUnregistered = yield* state.waiting("unregistered-release")
          yield* Scope.close(successorScope, Exit.void)

          // A third worker that does register the flow reclaims the run — the
          // silent drop must not have consumed the durable waiting row.
          const registered = yield* makeDriver("owner-3")
          yield* registered.register(TestFlow, () => Effect.succeed("reclaimed"))
          let row = yield* store.get("unregistered-release")
          for (let i = 0; i < 10 && row.status !== "completed"; i++) {
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            row = yield* store.get("unregistered-release")
          }

          return { warningsWhileUnregistered, rowWhileUnregistered, waitingWhileUnregistered, row }
        }).pipe(Effect.provide(Logger.layer([capture])))
      ))

      // The silent no-op is now a structured warning…
      expect(result.warningsWhileUnregistered.length).toBeGreaterThanOrEqual(1)
      // …logged once per run, not once per heartbeat tick…
      expect(result.warningsWhileUnregistered.length).toBe(1)
      expect(result.warningsWhileUnregistered[0]?.logLevel).toBe("Warn")
      expect(String(result.warningsWhileUnregistered[0]?.message)).toContain("unregistered-release")
      expect(String(result.warningsWhileUnregistered[0]?.message)).toContain(TestFlow._tag)
      // …and the run stays durably parked, reclaimable once registered.
      expect(result.rowWhileUnregistered.status).toBe("suspended")
      expect(result.waitingWhileUnregistered._tag).toBe("Some")
      expect(result.row.status).toBe("completed")
    }))
})

/**
 * B-01: the same reclaim path, for the run nothing else can reach.
 *
 * `drive()` returned as soon as the flow was unregistered — before the claim,
 * and so before the activation cancel guard that delivers a durable
 * cancellation. `sweepCancelRequested` woke the row every heartbeat and every
 * wake bailed at the same line, so a cancel requested from a control-only
 * process against a run parked under an unregistered flow was write-only
 * forever: the run stayed `suspended`, its linked children kept running, and
 * the only observable was one warning.
 *
 * Cancelling needs no handler. The terminal transition, the cascade over the
 * durable edge table, and the interruption record are all written from the run
 * ROW, so an unregistered process can close the run even though it could never
 * execute it.
 */
describe("a parked run of an unregistered flow still cancels (B-01)", () => {
  it.effect("cancels on one sweep tick, records the interruption, and cascades to linked children", () =>
    Effect.gen(function*() {
      const logs: Array<{ readonly message: unknown; readonly logLevel: string }> = []
      const capture = Logger.make((options) => {
        logs.push({ message: options.message, logLevel: options.logLevel })
      })

      const result = yield* withCrypto(provideJournal(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const state = yield* DurableEngineState.DurableEngineState
          const journal = yield* Journal.Journal
          yield* releaseMidAction("b01-parked")

          // A linked child, admitted by the run before it parked. The edge is
          // the durable subflow DAG, which is what a cascade walks — and the
          // only representation a process that never spawned the child has.
          yield* store.create("b01-child", JSON.stringify({
            version: 1,
            flowName: TestFlow._tag,
            payload: {},
            parentExecutionId: "b01-parked"
          }))
          yield* state.recordRunParent("b01-child", "b01-parked")

          // The control-only process: it has the store and the sweeper, and it
          // has never registered the flow.
          const successorScope = yield* Scope.make()
          yield* makeDriver("owner-cancel").pipe(Scope.provide(successorScope))
          yield* store.requestCancel("b01-parked", 1_000)
          yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))

          const row = yield* store.get("b01-parked")
          const child = yield* store.get("b01-child")
          const waiting = yield* state.waiting("b01-parked")
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "b01-parked" as never, limit: 200 })
          const interrupted = entries.entries.filter((entry) => entry.eventType === "flows.engine.interrupted")
          yield* Scope.close(successorScope, Exit.void)

          return {
            row,
            child,
            waiting,
            interrupted,
            warnings: logs
              .filter((entry) => String(entry.message).includes("not registered"))
              .map((entry) => String(entry.message))
          }
        }).pipe(Effect.provide(Logger.layer([capture])))
      ))

      expect(result.row.status).toBe("cancelled")
      // The waiting row is cleared with the transition, so the cancelled run
      // never surfaces to a sweeper again.
      expect(result.waiting._tag).toBe("None")
      expect(result.interrupted).toHaveLength(1)
      expect(result.interrupted[0]?.payload).toMatchObject({
        outcome: "cancelled",
        cascadedTo: ["b01-child"]
      })
      // The cascade is a durable request against the child row, which the
      // child's own owner (or its own sweep) then acts on.
      expect(result.child.cancelRequestedAtMs).not.toBeNull()
      // Cancelling is not the case the warning exists for: the parked run was
      // closed here rather than left for a worker that registers the flow.
      expect(result.warnings.filter((message) => message.includes("b01-parked"))).toHaveLength(0)
      // The child is the case it IS for. The cascade wakes it in this process,
      // which cannot execute it either, so it says so once and leaves the
      // durable request for a worker that registers the flow.
      expect(result.warnings.filter((message) => message.includes("b01-child"))).toHaveLength(1)
    }))
})
