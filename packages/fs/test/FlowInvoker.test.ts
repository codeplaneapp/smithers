import { Cause, Effect, Layer, Option } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import visibleFlow from "./fixtures/command/visible.ts"

const invocation = Object.freeze({ name: "visible", flow: visibleFlow, input: Object.freeze({ number: 1 }) })

describe("FlowInvoker", () => {
  it("constructs a frozen service from an own data function", async () => {
    const seen: Array<FlowInvoker.Invocation> = []
    const service = FlowInvoker.make({
      invoke: (input) =>
        Effect.sync(() => {
          seen.push(input)
          return "done"
        })
    })

    expect(Object.isFrozen(service)).toBe(true)
    expect(await Effect.runPromise(service.invoke(invocation))).toBe("done")
    expect(seen).toEqual([invocation])
  })

  it("rejects non-record, inherited, accessor, and non-function implementations", () => {
    const getter = vi.fn(() => () => Effect.void)
    const accessor = Object.defineProperty({}, "invoke", { enumerable: true, get: getter })
    const inherited = Object.create({ invoke: () => Effect.void })
    for (const input of [null, 1, {}, inherited, accessor, { invoke: true }]) {
      expect(() => FlowInvoker.make(input as never)).toThrow(TypeError)
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it("fails closed without retaining invocation data", async () => {
    const service = FlowInvoker.makeNoop()
    const secretInvocation = { ...invocation, name: "TOP-SECRET" }
    const exit = await Effect.runPromise(Effect.exit(service.invoke(secretInvocation)))

    expect(Object.isFrozen(service)).toBe(true)
    expect(exit._tag).toBe("Failure")
    if (exit._tag !== "Failure") return
    const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(error).toMatchObject({ code: "invocation_unavailable", method: "FlowInvoker.invoke" })
    expect(JSON.stringify(error)).not.toContain("TOP-SECRET")
  })

  it("accepts a valid override and provides it through the layer", async () => {
    const override = vi.fn(() => Effect.succeed("overridden"))
    const service = FlowInvoker.makeNoop({ invoke: override })
    const result = await Effect.runPromise(
      Effect.flatMap(FlowInvoker.FlowInvoker, (invoker) => invoker.invoke(invocation)).pipe(
        Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, service))
      )
    )
    const layered = await Effect.runPromise(
      Effect.flatMap(FlowInvoker.FlowInvoker, (invoker) => invoker.invoke(invocation)).pipe(
        Effect.provide(FlowInvoker.layerNoop({ invoke: override }))
      )
    )

    expect(result).toBe("overridden")
    expect(layered).toBe("overridden")
    expect(override).toHaveBeenCalledTimes(2)
  })

  it("rejects accessor and non-function overrides without invoking them", () => {
    const getter = vi.fn(() => () => Effect.void)
    const accessor = Object.defineProperty({}, "invoke", { enumerable: true, get: getter })
    for (const input of [accessor, { invoke: false }]) {
      expect(() => FlowInvoker.makeNoop(input as never)).toThrow(TypeError)
    }
    expect(getter).not.toHaveBeenCalled()
  })
})
