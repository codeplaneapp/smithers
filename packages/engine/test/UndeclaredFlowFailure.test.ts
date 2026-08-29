/**
 * A body failure outside the flow's declared error schema is a defect either
 * way, but `orDie` alone reports only the schema mismatch and never the error
 * that actually occurred — for a flow declaring no error at all, the whole
 * report was `InvalidType(<Never>)`. The log line below is the one place that
 * error is named, so it is pinned here, including for an error that cannot be
 * rendered as JSON.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Logger, References, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const Undeclared = Flow.make("UndeclaredFlowFailure/flow", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("unused")
})

interface Captured {
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** Runs a registered handler that fails, capturing what the engine logged. */
const failWith = (error: unknown, executionId: string) =>
  Effect.gen(function*() {
    const logs: Array<Captured> = []
    const capture = Logger.make((options) =>
      logs.push({
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    )
    const exit = yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Undeclared, () => Effect.fail(error as never))
      return yield* Effect.exit(Undeclared.execute({}, { executionId }))
    })).pipe(
      Effect.provide(FlowEngine.layerMemory),
      Effect.provideService(Logger.CurrentLoggers, new Set([capture]))
    )
    return { exit, logs }
  })

describe("a flow body failure outside the declared error schema", () => {
  effect("dies, and logs the flow and the error that could not be declared", () =>
    Effect.gen(function*() {
      const { exit, logs } = yield* failWith({ code: "outside-contract" }, "undeclared-json")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations).toMatchObject({
        flow: "UndeclaredFlowFailure/flow",
        error: "{\"code\":\"outside-contract\"}"
      })
    }))

  effect("still names the flow when the error cannot be rendered as JSON", () =>
    Effect.gen(function*() {
      // A cause chain that points back at itself: `JSON.stringify` throws on
      // it, and a log line that threw would replace the defect under
      // diagnosis with a defect about the diagnosis.
      const circular: { self?: unknown; toString: () => string } = {
        toString: () => "circular-failure"
      }
      circular.self = circular
      const { exit, logs } = yield* failWith(circular, "undeclared-circular")

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const line = logs.find((entry) => String(entry.message).includes("outside its declared error schema"))
      expect(line?.annotations).toMatchObject({
        flow: "UndeclaredFlowFailure/flow",
        error: "circular-failure"
      })
    }))
})
