/**
 * The adapter pinned against the contracts the durable engine enforces, using
 * runtime doubles that decorate the real in-memory `FlowRuntime`.
 *
 * `docs/migration/rc-contract.md` section 7 requires the durable engine to
 * refuse `FlowRuntime.interruptUnsafe` with `unsafe_interrupt_unsupported`, so
 * an adapter that cancels through it cannot run one interrupt pin against the
 * only durable engine that ships. Nothing in the repository caught that,
 * because the applied suite binds the memory layer, whose `interruptUnsafe`
 * works. These cases make the refusal explicit, and bound the publication
 * confirmation the adapter ends every run with.
 */
import { FlowEngine } from "@smthrs/engine"
import { FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as EngineSubject from "../../src/EngineSubject.ts"
import * as FlowEngineLike from "../../src/FlowEngineLike.ts"
import { describe, expect, it } from "../../src/Vitest.ts"

/** Decorates the in-memory runtime, keeping every other operation real. */
type Runtime = FlowRuntime.FlowRuntime["Service"]

const decorated = (
  decorate: (runtime: Runtime) => Partial<Runtime>
): Layer.Layer<EngineSubject.EngineSubject> =>
  FlowEngineLike.layerOver(
    Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(
        FlowRuntime.FlowRuntime,
        (runtime) => FlowRuntime.FlowRuntime.of({ ...runtime, ...decorate(runtime) })
      )
    ).pipe(Layer.provide(FlowEngine.layerMemory))
  )

const waiting: EngineSubject.FlowSpec = {
  name: "testing/engine-like/contract/waiting",
  steps: [{
    key: "waiting",
    sealed: false,
    kind: "step",
    run: () => Effect.never
  }]
}

const settling: EngineSubject.FlowSpec = {
  name: "testing/engine-like/contract/settling",
  steps: [{
    key: "settling",
    sealed: false,
    kind: "step",
    run: () => Effect.succeed("done")
  }]
}

const unsafeCalls = { count: 0 }

const countsUnsafe = decorated((real) => ({
  interruptUnsafe: (flow, executionId) =>
    Effect.suspend(() => {
      unsafeCalls.count += 1
      return real.interruptUnsafe(flow, executionId)
    })
}))

const refusesUnsafe = decorated(() => ({
  interruptUnsafe: (_flow, executionId) =>
    Effect.fail(
      new FlowRuntime.CancelRequestFailed({
        code: "unsafe_interrupt_unsupported",
        executionId,
        reason: "the durable engine has one cancellation path"
      })
    )
}))

const neverPublishes = decorated(() => ({ poll: () => Effect.succeed(Option.none()) }))

const cancelled = (executionId: string) =>
  Effect.gen(function*() {
    const engine = yield* EngineSubject.EngineSubject
    const running = yield* Effect.forkChild(
      engine.run({ flow: waiting, payload: undefined, executionId }),
      { startImmediately: true }
    )
    yield* Effect.yieldNow
    yield* engine.interrupt(executionId)
    yield* Fiber.await(running)
    return yield* engine.result(executionId)
  })

describe("FlowEngineLike honours the durable cancellation contract", () => {
  it.scoped("cancels through interrupt and never touches interruptUnsafe", () =>
    Effect.gen(function*() {
      const result = yield* cancelled("testing/engine-like/contract/cancel")
      expect(result.status).toBe("aborted")
      expect(unsafeCalls.count).toBe(0)
    }).pipe(Effect.provide(countsUnsafe)))

  it.scoped("still cancels when the runtime refuses interruptUnsafe the way the durable engine does", () =>
    Effect.gen(function*() {
      const result = yield* cancelled("testing/engine-like/contract/refused")
      expect(result.status).toBe("aborted")
    }).pipe(Effect.provide(refusesUnsafe)))
})

describe("FlowEngineLike bounds its publication confirmation", () => {
  it.scoped("fails typed instead of spinning when the runtime never publishes a result", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const error = yield* engine.run({
        flow: settling,
        payload: undefined,
        executionId: "testing/engine-like/contract/unpublished"
      }).pipe(Effect.flip)
      expect(error._tag).toBe("EngineUnavailableError")
      expect((error as { readonly message: string }).message).toContain("did not publish its result")
    }).pipe(Effect.provide(neverPublishes)))
})
