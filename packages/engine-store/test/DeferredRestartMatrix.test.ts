import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "test-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * Runs `body` against two independently constructed engines that share one
 * durable state and journal: the first suspends the flow, the second is the
 * post-restart engine.
 */
const withRestart = <A>(
  body: (
    makeEngine: Effect.Effect<
      FlowRuntime.FlowRuntime["Service"],
      never,
      RunStore.RunStore | DurableEngineState.DurableEngineState | Journal.Journal | Jj.Jj | StepBoundary.Service
    >,
    store: RunStore.RunStore["Service"]
  ) => Effect.Effect<A, any, any>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const makeEngine = EngineStore.make({
          owner: { hostId: "deferred-restart-host" },
          journalSource: "deferred-restart-test",
          isAlive: () => Effect.succeed(false)
        })
        return yield* body(makeEngine as any, store)
      }).pipe(
        Effect.provideService(
          DurableEngineState.DurableEngineState,
          DurableEngineState.makeMemory()
        ),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer())
    ) as Effect.Effect<A, unknown>
  )

describe("durable deferred outcomes across a restart", () => {
  /**
   * Parity: Skyframe `StateMachineTest.java:335` — a dependency that fails,
   * dies, or is recovered from must behave identically after the evaluator is
   * rebuilt from persisted state.
   */
  const gate = DurableDeferred.make("restart-gate", {
    success: Schema.String,
    error: Schema.String
  })

  const scenario = (
    name: string,
    options: {
      readonly handler: (
        prefix: string
      ) => Effect.Effect<string, string, any>
      readonly exit: Exit.Exit<string, string>
      readonly assert: (exit: Exit.Exit<string, unknown>) => void
    }
  ) =>
    it.effect(name, () =>
      Effect.gen(function*() {
        let prefixDispatches = 0
        const flow = Flow.make(`DeferredRestart/${name}`, {
          payload: {},
          success: Schema.String,
          error: Schema.String,
          body: opaqueHandlerBody
        })
        const prefix = Action.make({
          name: "prefix",
          success: Schema.String,
          tier: "sealed",
          idempotencyKey: `deferred-restart-${name}-v1`,
          execute: Effect.sync(() => {
            prefixDispatches++
            return "prefix-result"
          })
        })
        const handler = () =>
          Effect.gen(function*() {
            const value = yield* prefix
            return yield* options.handler(value)
          })

        const result = yield* withRestart((makeEngine, store) =>
          Effect.gen(function*() {
            const first = yield* makeEngine
            yield* first.register(flow as any, handler as any)
            yield* first.execute(flow as any, {
              executionId: "restart-run",
              payload: {},
              discard: true
            })
            const suspended = yield* store.get("restart-run")

            const restarted = yield* makeEngine
            yield* restarted.register(flow as any, handler as any)
            yield* restarted.deferredDone(gate, {
              flowName: flow._tag,
              executionId: "restart-run",
              deferredName: gate.name,
              exit: options.exit as any
            })
            const exit = yield* Effect.exit(
              restarted.execute(flow as any, {
                executionId: "restart-run",
                payload: {},
                discard: false
              })
            )
            const final = yield* store.get("restart-run")
            return { suspended, exit, final }
          })
        )

        expect(result.suspended.status).toBe("suspended")
        // the sealed prefix runs once, before the suspension, and is replayed
        // from persisted evidence by the restarted engine
        expect(prefixDispatches).toBe(1)
        options.assert(result.exit as Exit.Exit<string, unknown>)
      }))

  scenario("propagates an unhandled typed failure recorded while suspended", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.fail("gate-failed"),
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("gate-failed")
      }
    }
  })

  scenario("lets the restarted handler recover from a typed failure", {
    handler: (value) =>
      DurableDeferred.await(gate).pipe(
        Effect.catch((error) => Effect.succeed(`recovered:${error}`)),
        Effect.map((gated) => `${value}/${gated}`)
      ),
    exit: Exit.fail("gate-failed"),
    assert: (exit) => {
      expect(exit).toStrictEqual(Exit.succeed("prefix-result/recovered:gate-failed"))
    }
  })

  scenario("propagates a defect recorded while suspended as a die cause", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.die("gate-defect") as Exit.Exit<string, string>,
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    }
  })

  scenario("propagates a recorded interruption as an interrupt cause", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.failCause(Cause.interrupt()) as Exit.Exit<string, string>,
    assert: (exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
      }
    }
  })

  scenario("succeeds from the persisted success exit without redispatching the prefix", {
    handler: (value) => Effect.map(DurableDeferred.await(gate), (gated) => `${value}/${gated}`),
    exit: Exit.succeed("gate-value"),
    assert: (exit) => {
      expect(exit).toStrictEqual(Exit.succeed("prefix-result/gate-value"))
    }
  })
})

describe("partial dependency readiness across a restart", () => {
  const first = DurableDeferred.make("partial-first", { success: Schema.String })
  const second = DurableDeferred.make("partial-second", { success: Schema.String })

  /**
   * Parity: Skyframe `ParallelEvaluatorTest.java:3442` — when only one of the
   * requested dependencies becomes available, the machine makes partial
   * progress and re-suspends on the still-outstanding one rather than
   * completing or restarting from scratch.
   */
  it.effect("resumes past the ready dependency and re-suspends on the outstanding one", () =>
    Effect.gen(function*() {
      const observed: Array<string> = []
      let prefixDispatches = 0
      const flow = Flow.make("DeferredRestart/partial", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const prefix = Action.make({
        name: "prefix",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "deferred-partial-prefix-v1",
        execute: Effect.sync(() => {
          prefixDispatches++
          return "prefix-result"
        })
      })
      const handler = () =>
        Effect.gen(function*() {
          const base = yield* prefix
          const a = yield* DurableDeferred.await(first)
          observed.push(`first:${a}`)
          const b = yield* DurableDeferred.await(second)
          observed.push(`second:${b}`)
          return `${base}/${a}/${b}`
        })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* engine.execute(flow, {
            executionId: "partial-run",
            payload: {},
            discard: true
          })
          const beforeAny = yield* store.get("partial-run")

          // only the first dependency becomes ready
          const afterFirstEngine = yield* makeEngine
          yield* afterFirstEngine.register(flow as any, handler as any)
          yield* afterFirstEngine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "partial-run",
            deferredName: first.name,
            exit: Exit.succeed("a")
          })
          yield* afterFirstEngine.execute(flow as any, {
            executionId: "partial-run",
            payload: {},
            discard: true
          })
          const afterFirst = yield* store.get("partial-run")

          // and only then the second one
          const finalEngine = yield* makeEngine
          yield* finalEngine.register(flow as any, handler as any)
          yield* finalEngine.deferredDone(second, {
            flowName: flow._tag,
            executionId: "partial-run",
            deferredName: second.name,
            exit: Exit.succeed("b")
          })
          const value = yield* finalEngine.execute(flow as any, {
            executionId: "partial-run",
            payload: {},
            discard: false
          })
          const final = yield* store.get("partial-run")

          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({
            runId: "partial-run" as never,
            limit: 200
          })
          return { beforeAny, afterFirst, final, value, entries }
        })
      )

      expect(result.beforeAny.status).toBe("suspended")
      // partial progress: the run advanced past `first` but is still waiting on `second`
      expect(result.afterFirst.status).toBe("suspended")
      expect(result.final.status).toBe("completed")
      expect(result.value).toBe("prefix-result/a/b")
      // the ready dependency is observed exactly once per replay pass and never
      // observed before it was recorded
      expect(observed.filter((entry) => entry === "first:a").length).toBeGreaterThanOrEqual(1)
      expect(observed.filter((entry) => entry === "second:b")).toEqual(["second:b"])
      expect(prefixDispatches).toBe(1)
      expect(
        result.entries.entries.filter((entry) => entry.eventType === "flows.engine.deferred-completed")
      ).toHaveLength(2)
    }))

  /**
   * Parity: Skyframe `StateMachineTest.java:283` — several independently
   * suspended branches must be satisfiable in any order; resolving them out of
   * request order must not deadlock or lose the earlier resolution.
   */
  it.effect("accepts out-of-order resolution of concurrently awaited dependencies", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DeferredRestart/out-of-order", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const handler = () =>
        Effect.gen(function*() {
          const a = yield* DurableDeferred.await(first)
          const b = yield* DurableDeferred.await(second)
          return `${a}+${b}`
        })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* engine.execute(flow, {
            executionId: "ooo-run",
            payload: {},
            discard: true
          })

          // resolve the *later* dependency first
          const restarted = yield* makeEngine
          yield* restarted.register(flow as any, handler as any)
          yield* restarted.deferredDone(second, {
            flowName: flow._tag,
            executionId: "ooo-run",
            deferredName: second.name,
            exit: Exit.succeed("b") as any
          })
          yield* restarted.execute(flow as any, {
            executionId: "ooo-run",
            payload: {},
            discard: true
          })
          const stillSuspended = yield* store.get("ooo-run")

          const finalEngine = yield* makeEngine
          yield* finalEngine.register(flow as any, handler as any)
          yield* finalEngine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "ooo-run",
            deferredName: first.name,
            exit: Exit.succeed("a") as any
          })
          const value = yield* finalEngine.execute(flow as any, {
            executionId: "ooo-run",
            payload: {},
            discard: false
          })
          return { stillSuspended, value }
        })
      )

      // the out-of-order completion is retained, not dropped
      expect(result.stillSuspended.status).toBe("suspended")
      expect(result.value).toBe("a+b")
    }))

  /**
   * Parity: Skyframe `ParallelEvaluatorTest.java`
   * `partialReevaluationOneDuringAReevaluation` — a dependency that becomes
   * ready *while a partial reevaluation is already in flight* must be
   * consumed by that reevaluation (or the coalesced follow-up drive), not
   * lost and not require an external re-drive.
   */
  it.effect("consumes a second deferred completion that lands during an in-flight partial resume", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DeferredRestart/mid-resume", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })

      const result = yield* withRestart((makeEngine, store) =>
        Effect.gen(function*() {
          // in-memory latches: `reachedGate` is signalled by the resume pass
          // after it consumed `first`; `gate` holds that pass open so the test
          // can land `second`'s completion while the resume is still live
          const reachedGate = yield* Deferred.make<void>()
          const gate = yield* Deferred.make<void>()
          const handler = () =>
            Effect.gen(function*() {
              const a = yield* DurableDeferred.await(first)
              yield* Deferred.succeed(reachedGate, void 0)
              yield* Deferred.await(gate)
              const b = yield* DurableDeferred.await(second)
              return `${a}*${b}`
            })

          const engine = yield* makeEngine
          yield* engine.register(flow, handler)
          yield* engine.execute(flow, {
            executionId: "mid-resume-run",
            payload: {},
            discard: true
          })
          const suspendedRow = yield* store.get("mid-resume-run")

          yield* engine.deferredDone(first, {
            flowName: flow._tag,
            executionId: "mid-resume-run",
            deferredName: first.name,
            exit: Exit.succeed("a")
          })
          yield* Deferred.await(reachedGate)
          const inFlight = yield* store.get("mid-resume-run")

          // lands during the in-flight resume: the run is past `first` but the
          // resume pass has not yet requested `second`
          yield* engine.deferredDone(second, {
            flowName: flow._tag,
            executionId: "mid-resume-run",
            deferredName: second.name,
            exit: Exit.succeed("b")
          })
          yield* Deferred.succeed(gate, void 0)

          // no further execute/wake calls: the in-flight pass (or the wake
          // coalesced by the coordinator) must finish the run on its own
          let final = yield* store.get("mid-resume-run")
          for (let count = 0; count < 400 && final.status !== "completed"; count++) {
            yield* Effect.sleep("25 millis")
            final = yield* store.get("mid-resume-run")
          }
          return { suspendedRow, inFlight, final }
        })
      )

      expect(result.suspendedRow.status).toBe("suspended")
      // the second completion landed while the resume pass was live, not parked
      expect(result.inFlight.status).toBe("running")
      expect(result.final.status).toBe("completed")
      expect((JSON.parse(result.final.stateJson) as { result?: unknown }).result).toEqual({
        _tag: "Complete",
        exit: { _tag: "Success", value: "a*b" }
      })
    }))
})
