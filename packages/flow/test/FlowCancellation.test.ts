import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const TestFlow = Flow.make("Cancellation/test", {
  payload: {},
  body: () => Node.succeed(undefined)
})

const failure = new FlowRuntime.CancelRequestFailed({
  code: "cancel_request_failed",
  executionId: "cancellation-1",
  reason: "journal unavailable"
})

const layerFailingCancellation = Layer.effect(
  FlowRuntime.FlowRuntime,
  Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
    FlowRuntime.FlowRuntime.of({
      ...runtime,
      interrupt: () => Effect.fail(failure),
      interruptUnsafe: () => Effect.fail(failure)
    }))
).pipe(Layer.provide(layerMemory))

describe("Flow cancellation failures", () => {
  it.effect("Flow.interrupt forwards CancelRequestFailed unchanged", () =>
    Effect.gen(function*() {
      const observed = yield* withCrypto(
        Effect.flip(TestFlow.interrupt("cancellation-1")).pipe(Effect.provide(layerFailingCancellation))
      )

      expect(observed).toBe(failure)
      expect(observed).toMatchObject({
        _tag: "@smthrs/flow/CancelRequestFailed",
        code: "cancel_request_failed",
        executionId: "cancellation-1",
        reason: "journal unavailable"
      })
    }))

  it.effect("FlowRuntime.interruptUnsafe forwards the equivalent CancelRequestFailed unchanged", () =>
    Effect.gen(function*() {
      const observed = yield* withCrypto(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          return yield* Effect.flip(runtime.interruptUnsafe(TestFlow, "cancellation-1"))
        }).pipe(Effect.provide(layerFailingCancellation))
      )

      expect(observed).toBe(failure)
      expect(observed).toMatchObject({
        _tag: "@smthrs/flow/CancelRequestFailed",
        code: "cancel_request_failed",
        executionId: "cancellation-1",
        reason: "journal unavailable"
      })
    }))
})
