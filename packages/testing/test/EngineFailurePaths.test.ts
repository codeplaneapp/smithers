/**
 * Typed engine failures and lifecycle edges shared by the two reference
 * subjects.
 *
 * These are the black-box paths conformance consumers depend on when an id was
 * never claimed, a step fails, a race is malformed, or a live execution is
 * joined through resume. Each assertion names the stable error code or the
 * durable result and journal fields the caller observes.
 */
import { FlowEngine } from "@smthrs/engine"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Scope from "effect/Scope"
import type { EngineSubject as Subject, FlowSpec, StepSpec } from "../src/EngineSubject.ts"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import { type EngineSubjectError, EngineUnavailableError } from "../src/TestingError.ts"
import { describe, expect, it } from "../src/Vitest.ts"

const flowLayer = FlowEngineLike.layerOver(FlowEngine.layerMemory)

const onEachSubject = (
  name: string,
  body: (engine: Subject) => Effect.Effect<void, unknown>
): void => {
  it.scoped(`MemoryEngine ${name}`, () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      yield* body(yield* MemoryEngine.make(store))
    }))
  it.scoped(`FlowEngineLike ${name}`, () =>
    Effect.flatMap(EngineSubject.EngineSubject, body).pipe(Effect.provide(flowLayer)))
}

describe("unknown execution ids", () => {
  onEachSubject("fails reads and resume with engine_unavailable", (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/unknown/execution"
      const operations: ReadonlyArray<readonly [string, Effect.Effect<unknown, EngineSubjectError>]> = [
        ["result", engine.result(executionId)],
        ["resume", engine.resume(executionId)],
        ["journal", engine.journal(executionId)]
      ] as const

      for (const [operation, effect] of operations) {
        const error = yield* Effect.flip(effect)
        expect(error._tag, operation).toBe("EngineUnavailableError")
        expect(error.code, operation).toBe("engine_unavailable")
        expect((error as EngineUnavailableError).message, operation).toContain(executionId)
      }

      const interrupted = yield* Effect.exit(engine.interrupt(executionId))
      expect(interrupted._tag).toBe("Success")
      const stillUnknown = yield* Effect.flip(engine.result(executionId))
      expect(stillUnknown.code).toBe("engine_unavailable")
    }))
})

describe("failed flow bodies", () => {
  onEachSubject("journals a typed step failure", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/failed-step/${engine.name}`
      const refused = {
        _tag: "EngineUnavailableError",
        code: "engine_unavailable",
        message: "the step dependency is unavailable"
      } as const
      const result = yield* engine.run({
        flow: {
          name: `testing/failed-step/${engine.name}`,
          steps: [{
            key: "failed-step",
            sealed: false,
            kind: "step",
            run: () => Effect.fail(refused)
          }]
        },
        payload: undefined,
        executionId
      })

      expect(result).toMatchObject({
        executionId,
        status: "failed",
        value: { code: "engine_unavailable", message: "the step dependency is unavailable" }
      })
      expect(yield* engine.journal(executionId)).toEqual([
        expect.objectContaining({
          index: 0,
          stepKey: "failed-step",
          kind: "step",
          outcome: "failed",
          value: expect.objectContaining({ code: "engine_unavailable" })
        })
      ])
    }))

  onEachSubject("rejects a race with no branches", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/empty-race/${engine.name}`
      const result = yield* engine.run({
        flow: {
          name: `testing/empty-race/${engine.name}`,
          steps: [{ key: "empty-race", sealed: true, kind: "race", branches: [] }]
        },
        payload: undefined,
        executionId
      })

      expect(result.status).toBe("failed")
      expect(result.value).toMatchObject({ code: "engine_unavailable" })
      expect((result.value as EngineUnavailableError).message).toContain("has no branches")
      const journal = yield* engine.journal(executionId)
      expect(journal).toEqual(
        engine.name === "MemoryEngine"
          ? [expect.objectContaining({ stepKey: "empty-race", kind: "race", outcome: "failed" })]
          : []
      )
    }))

  onEachSubject("executes a nested race branch", (engine) =>
    Effect.gen(function*() {
      const executionId = `testing/nested-race/${engine.name}`
      const flow: FlowSpec = {
        name: `testing/nested-race/${engine.name}`,
        steps: [{
          key: "outer-race",
          sealed: true,
          kind: "race",
          branches: [{
            key: "inner-race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "winner",
              sealed: true,
              kind: "step",
              run: () => Effect.succeed("nested-winner")
            }]
          }, {
            key: "inner-race-loser",
            sealed: false,
            kind: "race",
            branches: [{
              key: "nested-loser",
              sealed: false,
              kind: "step",
              run: () => Effect.never
            }]
          }]
        }]
      }

      const result = yield* engine.run({ flow, payload: undefined, executionId })
      expect(result).toMatchObject({ executionId, status: "completed", value: "nested-winner" })
      expect(yield* engine.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "inner-race", kind: "race", outcome: "completed" })
      )
    }))
})

describe("MemoryEngine live execution joins", () => {
  it.scoped("resume joins the deferred of an execution that is still running", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const executionId = "testing/memory/live-resume"
      const flow: FlowSpec = {
        name: "testing/memory/live-resume",
        steps: [{
          key: "waiting",
          sealed: false,
          kind: "step",
          run: () => Effect.andThen(started.open, Effect.as(release.await, "done"))
        }]
      }

      const running = yield* engine.run({ flow, payload: undefined, executionId }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* started.await
      const resumed = yield* engine.resume(executionId).pipe(Effect.forkChild({ startImmediately: true }))
      yield* release.open

      expect(yield* Fiber.join(running)).toEqual({ executionId, status: "completed", value: "done" })
      expect(yield* Fiber.join(resumed)).toEqual({ executionId, status: "completed", value: "done" })
    }))

  it.scoped("interrupting a completed execution preserves its terminal result", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/terminal-interrupt"
      const completed = yield* engine.run({
        flow: {
          name: "testing/memory/terminal-interrupt",
          steps: [{ key: "done", sealed: false, kind: "step", run: () => Effect.succeed("done") }]
        },
        payload: undefined,
        executionId
      })
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual(completed)
    }))

  it.scoped("suspends and aborts without inventing a frontier after every sealed step is recorded", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const executionScope = yield* Scope.make()
      const engine = yield* MemoryEngine.make(store).pipe(Effect.provideService(Scope.Scope, executionScope))
      const executionId = "testing/memory/recorded-tail"
      let runs = 0
      const sealed: StepSpec = {
        key: "sealed",
        sealed: true,
        kind: "step",
        run: () => Effect.sync(() => ++runs)
      }
      const running = yield* engine.run({
        flow: {
          name: "testing/memory/recorded-tail",
          steps: Array.from({ length: 50_000 }, () => sealed)
        },
        payload: undefined,
        executionId
      }).pipe(Effect.forkChild({ startImmediately: true }))

      while ((yield* engine.journal(executionId)).length === 0) {
        yield* Effect.yieldNow
      }
      yield* Scope.close(executionScope, Exit.void)

      expect(yield* Fiber.join(running)).toEqual({ executionId, status: "suspended" })
      expect(runs).toBe(1)
      expect(yield* engine.journal(executionId)).toEqual([
        expect.objectContaining({ stepKey: "sealed", outcome: "completed", value: 1 })
      ])

      const restarted = yield* MemoryEngine.make(store)
      yield* restarted.interrupt(executionId)
      expect(yield* restarted.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect(yield* restarted.journal(executionId)).toHaveLength(1)
    }))

  it.scoped("replays a nested race winner recorded before its wrapper", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const executionScope = yield* Scope.make()
      const engine = yield* MemoryEngine.make(store).pipe(Effect.provideService(Scope.Scope, executionScope))
      const loserStarted = yield* Latch.make()
      const loserFinalizing = yield* Latch.make()
      const releaseLoser = yield* Latch.make()
      const executionId = "testing/memory/nested-race-replay"
      let winnerRuns = 0
      const flow: FlowSpec = {
        name: "testing/memory/nested-race-replay",
        steps: [{
          key: "outer",
          sealed: true,
          kind: "race",
          branches: [{
            key: "nested",
            sealed: true,
            kind: "race",
            branches: [{
              key: "winner",
              sealed: true,
              kind: "step",
              run: () => Effect.andThen(loserStarted.await, Effect.sync(() => ++winnerRuns))
            }, {
              key: "loser",
              sealed: false,
              kind: "step",
              run: () =>
                Effect.acquireUseRelease(
                  loserStarted.open,
                  () => Effect.never,
                  () => Effect.andThen(loserFinalizing.open, releaseLoser.await)
                )
            }]
          }]
        }]
      }
      const running = yield* engine.run({ flow, payload: undefined, executionId }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* loserFinalizing.await

      const partial = yield* engine.journal(executionId)
      expect(partial).toContainEqual(expect.objectContaining({ stepKey: "winner", outcome: "completed", value: 1 }))
      expect(partial).not.toContainEqual(expect.objectContaining({ stepKey: "nested", outcome: "completed" }))

      const closing = yield* Scope.close(executionScope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* releaseLoser.open
      yield* Fiber.join(closing)
      expect((yield* Fiber.join(running)).status).toBe("suspended")

      const restarted = yield* MemoryEngine.make(store)
      expect(yield* restarted.resume(executionId)).toEqual({ executionId, status: "completed", value: 1 })
      expect(winnerRuns).toBe(1)
      expect(yield* restarted.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "nested", outcome: "completed", value: 1 })
      )
    }))

  it.scoped("finds the suspended frontier after completed sealed and occurrence steps", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/suspended-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/suspended-frontier",
          steps: [
            { key: "sealed", sealed: true, kind: "step", run: () => Effect.succeed("sealed") },
            { key: "sealed", sealed: true, kind: "step", run: () => Effect.succeed("unused") },
            { key: "occurrence", sealed: false, kind: "step", run: () => Effect.succeed("first") },
            { key: "occurrence", sealed: false, kind: "step", run: () => Effect.succeed("second") },
            { key: "frontier", sealed: false, kind: "step", run: () => Effect.interrupt }
          ]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")

      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      const journal = yield* engine.journal(executionId)
      expect(journal.filter((entry) => entry.stepKey === "sealed" && entry.outcome === "completed")).toHaveLength(1)
      expect(journal.filter((entry) => entry.stepKey === "occurrence" && entry.outcome === "completed")).toHaveLength(2)
      expect(journal.at(-1)).toMatchObject({ stepKey: "frontier", outcome: "aborted" })
    }))

  it.scoped("finds the suspended frontier after a completed race", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-frontier",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{ key: "winner", sealed: false, kind: "step", run: () => Effect.succeed("won") }]
          }, {
            key: "frontier",
            sealed: false,
            kind: "step",
            run: () => Effect.interrupt
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect((yield* engine.journal(executionId)).at(-1)).toMatchObject({
        stepKey: "frontier",
        outcome: "aborted"
      })
    }))

  it.scoped("reuses a recorded race winner while resuming its later frontier", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      let raceRuns = 0
      let frontierRuns = 0
      const executionId = "testing/memory/race-resume"
      const flow: FlowSpec = {
        name: "testing/memory/race-resume",
        steps: [{
          key: "race",
          sealed: true,
          kind: "race",
          branches: [{
            key: "winner",
            sealed: false,
            kind: "step",
            run: () => Effect.sync(() => ++raceRuns).pipe(Effect.as("won"))
          }]
        }, {
          key: "frontier",
          sealed: false,
          kind: "step",
          run: () =>
            Effect.suspend(() => {
              frontierRuns += 1
              return frontierRuns === 1 ? Effect.interrupt : Effect.succeed("resumed")
            })
        }]
      }

      expect((yield* engine.run({ flow, payload: undefined, executionId })).status).toBe("suspended")
      expect(yield* engine.resume(executionId)).toEqual({ executionId, status: "completed", value: "resumed" })
      expect({ raceRuns, frontierRuns }).toEqual({ raceRuns: 1, frontierRuns: 2 })
    }))

  it.scoped("records a failed race branch before another branch wins", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-branch-failure"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-branch-failure",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "refused",
              sealed: false,
              kind: "step",
              run: () => Effect.fail({ code: "engine_unavailable", message: "branch refused" })
            }, {
              key: "winner",
              sealed: false,
              kind: "step",
              run: () => Effect.andThen(Effect.yieldNow, Effect.succeed("winner"))
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result).toEqual({ executionId, status: "completed", value: "winner" })
      expect(yield* engine.journal(executionId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stepKey: "refused",
          outcome: "failed",
          value: { code: "engine_unavailable", message: "branch refused" }
        }),
        expect.objectContaining({ stepKey: "winner", outcome: "completed", value: "winner" })
      ]))
    }))

  it.scoped("records a branch that self-interrupts before another branch wins", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/race-self-interrupt"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/race-self-interrupt",
          steps: [{
            key: "race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "self-interrupted",
              sealed: false,
              kind: "step",
              run: () => Effect.interrupt
            }, {
              key: "winner",
              sealed: false,
              kind: "step",
              run: () => Effect.andThen(Effect.yieldNow, Effect.succeed("winner"))
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result).toEqual({ executionId, status: "completed", value: "winner" })
      expect(yield* engine.journal(executionId)).toContainEqual(
        expect.objectContaining({ stepKey: "self-interrupted", outcome: "aborted" })
      )
    }))

  it.scoped("finds a race itself as the frontier when no branch completed", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* MemoryEngine.make(store)
      const executionId = "testing/memory/suspended-race-frontier"
      const result = yield* engine.run({
        flow: {
          name: "testing/memory/suspended-race-frontier",
          steps: [{
            key: "suspended-race",
            sealed: true,
            kind: "race",
            branches: [{
              key: "self-interrupted",
              sealed: false,
              kind: "step",
              run: () => Effect.interrupt
            }]
          }]
        },
        payload: undefined,
        executionId
      })
      expect(result.status).toBe("suspended")
      yield* engine.interrupt(executionId)
      expect(yield* engine.result(executionId)).toEqual({ executionId, status: "aborted" })
      expect((yield* engine.journal(executionId)).at(-1)).toMatchObject({
        stepKey: "suspended-race",
        outcome: "aborted"
      })
    }))

  it.scoped("provides the engine through its public layer", () =>
    Effect.gen(function*() {
      const store = yield* MemoryEngine.makeStore()
      const engine = yield* EngineSubject.EngineSubject.pipe(Effect.provide(MemoryEngine.layer(store)))
      expect(engine.name).toBe("MemoryEngine")
    }))
})
