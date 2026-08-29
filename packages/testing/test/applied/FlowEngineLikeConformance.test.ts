/**
 * Production engine conformance application.
 *
 * Source parity:
 * `docs/specs/Research/Smithers Test Parity 2026-07-28.md` and
 * `docs/reference/test-parity.md`.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import * as Conformance from "../../src/Conformance.ts"
import * as EngineSubject from "../../src/EngineSubject.ts"
import * as FlowEngineLike from "../../src/FlowEngineLike.ts"
import { describe, expect, it } from "../../src/Vitest.ts"

describe("FlowEngineLike.layerMemory conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(FlowEngineLike.layerMemory)
      ))
  }

  // Pins delayed settlement: an execution whose only step settles far in the
  // future is still reported with its own outcome and value, and the waiting
  // fiber never holds the virtual clock back. This asserts the observable
  // contract of `awaitResult`; it does not on its own distinguish a suspending
  // waiter from a spinning one.
  it.scoped("reports a delayed completion once the step settles", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const running = yield* Effect.forkChild(
        engine.run({
          flow: {
            name: "testing/engine-like/delayed-completion",
            steps: [{
              key: "delayed-completion",
              sealed: false,
              kind: "step",
              run: () => Effect.as(Effect.sleep("1 hour"), "settled")
            }]
          },
          payload: undefined
        }),
        { startImmediately: true }
      )

      // The engine crosses real async hops before the step's sleep registers
      // with the TestClock, so a single adjust can fire into an empty clock
      // under load and strand the sleep forever. Pump instead: flush a few
      // real milliseconds, advance a virtual hour, repeat — whichever pass
      // finds the sleep registered releases it, deterministically.
      const pump = Effect.forever(
        TestClock.withLive(Effect.sleep("5 millis")).pipe(
          Effect.andThen(TestClock.adjust("1 hour"))
        )
      )

      expect(yield* Effect.raceFirst(Fiber.join(running), pump)).toMatchObject({
        status: "completed",
        value: "settled"
      })
    }).pipe(Effect.provide(FlowEngineLike.layerMemory)))
})
