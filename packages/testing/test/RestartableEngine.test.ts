import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Ref from "effect/Ref"
import type { FlowSpec } from "../src/EngineSubject.ts"
import * as RestartableEngine from "../src/RestartableEngine.ts"
import { expect, it } from "../src/Vitest.ts"

it.scoped("restarts over the same store and executes only the frontier", () =>
  Effect.gen(function*() {
    const harness = yield* RestartableEngine.make()
    const prefixRuns = yield* Ref.make(0)
    const frontierRuns = yield* Ref.make(0)
    const firstFrontierStarted = yield* Latch.make()
    const resumedFrontierStarted = yield* Latch.make()
    const releaseFrontier = yield* Latch.make()
    const executionId = "restartable/frontier/execution"
    const prefixKey = "restartable/frontier/prefix"
    const frontierKey = "restartable/frontier/parked"
    const flow: FlowSpec = {
      name: "testing/restartable/frontier",
      steps: [
        {
          key: prefixKey,
          sealed: true,
          kind: "step",
          run: (input) =>
            Ref.updateAndGet(prefixRuns, (count) => count + 1).pipe(
              Effect.as({ input, prefix: "complete" })
            )
        },
        {
          key: frontierKey,
          sealed: false,
          kind: "step",
          run: (input) =>
            Effect.gen(function*() {
              const count = yield* Ref.updateAndGet(
                frontierRuns,
                (current) => current + 1
              )
              yield* (
                count === 1
                  ? firstFrontierStarted.open
                  : resumedFrontierStarted.open
              )
              yield* releaseFrontier.await
              return { input, frontier: "complete" }
            })
        }
      ]
    }

    const initialRun = yield* harness.engine.run({
      flow,
      payload: { command: "restart" },
      executionId
    }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* firstFrontierStarted.await

    const resumedRun = yield* harness.killAndResume(executionId).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    yield* resumedFrontierStarted.await

    expect(yield* Ref.get(prefixRuns)).toBe(1)
    expect(yield* Ref.get(frontierRuns)).toBe(2)

    yield* releaseFrontier.open
    const initialResult = yield* Fiber.join(initialRun)
    const resumedResult = yield* Fiber.join(resumedRun)
    const journal = yield* harness.engine.journal(executionId)

    expect(initialResult.status).toBe("suspended")
    expect(resumedResult.status).toBe("completed")
    expect(journal).toEqual([
      {
        index: 0,
        stepKey: prefixKey,
        kind: "step",
        outcome: "completed",
        value: {
          input: { command: "restart" },
          prefix: "complete"
        }
      },
      {
        index: 1,
        stepKey: frontierKey,
        kind: "step",
        outcome: "suspended"
      },
      {
        index: 2,
        stepKey: frontierKey,
        kind: "step",
        outcome: "completed",
        value: {
          input: {
            input: { command: "restart" },
            prefix: "complete"
          },
          frontier: "complete"
        }
      }
    ])
  }))

/**
 * `kill` is the hard-kill half of the harness: the instance it replaces is
 * dropped, not closed.
 *
 * `restart` already proves the orderly half above — the outgoing instance's
 * scope closes, so its in-flight execution is interrupted and reports
 * `suspended`. A process killed with SIGKILL does neither: its fibers are not
 * interrupted, its finalizers never run, and it never releases what it held.
 * That is the state `Ownership.leaseLiveness` reclaims from, so a durable test
 * cannot produce it with `restart`.
 */
it.scoped("kill leaves the abandoned instance running and unreleased", () =>
  Effect.gen(function*() {
    const harness = yield* RestartableEngine.make()
    const started = yield* Latch.make()
    const release = yield* Latch.make()
    const executionId = "restartable/kill/execution"
    const flow: FlowSpec = {
      name: "testing/restartable/kill",
      steps: [
        {
          key: "restartable/kill/step",
          sealed: false,
          kind: "step",
          run: (input) =>
            Effect.gen(function*() {
              yield* started.open
              yield* release.await
              return { input, step: "complete" }
            })
        }
      ]
    }

    const running = yield* harness.engine.run({
      flow,
      payload: { command: "kill" },
      executionId
    }).pipe(Effect.forkChild({ startImmediately: true }))
    yield* started.await

    yield* harness.kill

    // The killed instance kept its fiber: releasing the latch lets the
    // execution the dead engine was driving finish on its own. A `restart`
    // would have interrupted it and answered `suspended` instead.
    yield* release.open
    const abandonedResult = yield* Fiber.join(running)
    expect(abandonedResult.status).toBe("completed")

    // The facade now serves the fresh instance over the same store.
    const survivor = yield* harness.engine.result(executionId)
    expect(survivor.status).toBe("completed")
  }))
