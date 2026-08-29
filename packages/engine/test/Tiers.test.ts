// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

describe("action durability tiers", () => {
  effect("sealed actions replay from the memory memo", () => {
    let calls = 0
    const step = Action.make({
      name: "Tiers/sealed",
      success: Schema.Number,
      tier: "sealed",
      idempotencyKey: "sealed/replay",
      execute: Effect.sync(() => ++calls)
    })
    const flowActionDeclaration = Action.make("Tiers/sealed/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Tiers/sealed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.andThen(step, step)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(1)
      expect(calls).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("rejects irreversible retries without an idempotency key", () => {
    const step = Action.make({
      name: "Tiers/irreversible-no-key",
      tier: "irreversible",
      success: Schema.Void,
      error: Schema.String,
      execute: Effect.fail("retry")
    })
    const flowActionDeclaration = Action.make("Tiers/irreversible-no-key/action", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "one" }, { executionId: "run" }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(exit._tag === "Failure" && exit.cause.toString()).toContain("IrreversibleRetryRequiresIdempotencyKey")
    }).pipe(Effect.provide(layer))
  })

  effect("allows irreversible retries when an idempotency key is supplied", () => {
    let attempts = 0
    const step = Action.make({
      name: "Tiers/irreversible-keyed",
      tier: "irreversible",
      idempotencyKey: "payment/one",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => ++attempts === 1 ? Effect.fail("retry") : Effect.succeed(2))
    })
    const flowActionDeclaration = Action.make("Tiers/irreversible-keyed/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(2)
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})
