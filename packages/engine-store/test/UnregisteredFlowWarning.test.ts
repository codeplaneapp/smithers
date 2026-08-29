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
import type { Journal } from "@smthrs/journal"
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
