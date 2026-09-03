import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #26: a drive-fiber interruption that is not an operator
 * cancellation — process shutdown closing the coordinator scope, or the
 * heartbeat loop self-interrupting on a transient error — must leave the run
 * reclaimable (Temporal worker-shutdown semantics), never durably
 * `cancelled`. Only an interruption backed by a durable cancel request
 * (`cancel_requested_at_ms`) may close the run terminally.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("ShutdownRelease/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const owner: Ownership.OwnerId = {
  hostId: "shutdown-host",
  pid: 1,
  nonce: "shutdown-owner"
}

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = () =>
  RunDriver.make({
    owner,
    journalSource: "shutdown-release",
    isAlive: () => Effect.succeed(true),
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

describe("shutdown releases instead of cancelling (issue #26)", () => {
  it.effect("an external drive-fiber interruption parks the run reclaimably", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const journal = yield* Journal.Journal
        // The driver lives in its own scope so the test can close it while a
        // flow is in flight, exactly like process shutdown tearing down the
        // coordinator's fiber set.
        const driverScope = yield* Scope.make()
        const driver = yield* makeDriver().pipe(Scope.provide(driverScope))
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        yield* driver.execute(TestFlow, {
          executionId: "shutdown-interrupt",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        // Process shutdown: the scope closes and interrupts the drive fiber.
        // No operator asked for cancellation.
        yield* Scope.close(driverScope, Exit.void)
        const row = yield* store.get("shutdown-interrupt")
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "shutdown-interrupt" as never, limit: 100 })
        return { row, eventTypes: entries.entries.map((entry) => entry.eventType) }
      })))

      // Reclaimable, not terminally closed: another worker must be able to
      // claim and resume this run.
      expect(result.row.status).toBe("suspended")
      expect(result.row.owner).toBeNull()
      expect(result.eventTypes).not.toContain("flows.engine.interrupted")
    }))

  it.effect("operator interrupt still durably cancels the run", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        const fiber = yield* driver.execute(TestFlow, {
          executionId: "shutdown-operator-cancel",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        yield* driver.interrupt(TestFlow, "shutdown-operator-cancel")
        yield* Fiber.await(fiber)
        const row = yield* store.get("shutdown-operator-cancel")
        return { row }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.row.cancelRequestedAtMs).not.toBeNull()
      expect(result.row.owner).toBeNull()
    }))
})
