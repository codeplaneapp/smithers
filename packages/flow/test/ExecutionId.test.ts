// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const Echo = Action.make("ExecutionId/echo", {
  payload: { value: Schema.String },
  success: Schema.String
})

const Idempotent = Flow.make("ExecutionId/Idempotent", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => `key:${value}`,
  body: ({ value }) => Echo.call({ value })
})

const IdempotentLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Idempotent)
  )
)

/** A flow that declares no key: identity comes from the ambient source. */
const Anonymous = Flow.make("ExecutionId/Anonymous", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

/** The same declaration under another tag, to prove the tag is derived on. */
const Twin = Flow.make("ExecutionId/Twin", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

const AnonymousLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Anonymous)
  )
)

/** A host source that answers every flow with one id. */
const fixed = (executionId: string) => Flow.layerExecutionIds({ mint: () => Effect.succeed(executionId) })

describe("Flow execution identities", () => {
  effect("an explicit execution id wins over the idempotency key", () =>
    Effect.gen(function*() {
      const executionId = yield* Idempotent.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(IdempotentLayer)))

  effect("derives a stable deterministic id from an opt-in idempotency key", () =>
    Effect.gen(function*() {
      const first = yield* Idempotent.executionId({ value: "stable" })
      const second = yield* Idempotent.executionId({ value: "stable" })
      const other = yield* Idempotent.executionId({ value: "other" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
    }))

  effect("an explicit execution id wins over the ambient source", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))

  effect("a declared idempotency key wins over the ambient source", () =>
    Effect.gen(function*() {
      const derived = yield* Idempotent.executionId({ value: "same" })
      const executionId = yield* Idempotent.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe(derived)
      expect(executionId).not.toBe("ambient-id")
    }).pipe(Effect.provide(IdempotentLayer), Effect.provide(fixed("ambient-id"))))

  effect("the ambient source names an execution the caller and the flow left unnamed", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe("ambient-id")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))
})

describe("the default execution-id source", () => {
  effect("runs a flow that named no identity at all, and answers with its value", () =>
    Effect.gen(function*() {
      // The whole point: this is `yield* F.execute(payload)`, with no
      // executionId, no idempotencyKey, and no layer wiring identity.
      const value = yield* Anonymous.execute({ value: "unnamed" })
      expect(value).toBe("unnamed")
    }).pipe(Effect.provide(AnonymousLayer)))

  effect("derives one stable id per (flow tag, payload) pair", () =>
    Effect.gen(function*() {
      const first = yield* Anonymous.executionId({ value: "stable" })
      const second = yield* Anonymous.executionId({ value: "stable" })
      const otherPayload = yield* Anonymous.executionId({ value: "other" })
      const otherFlow = yield* Twin.executionId({ value: "stable" })
      expect(first).toBe(second)
      expect(first).not.toBe(otherPayload)
      // The tag is part of the derivation, so two flows of the same shape do
      // not share an execution.
      expect(first).not.toBe(otherFlow)
    }))

  effect("agrees with the id execute runs under", () =>
    Effect.gen(function*() {
      const predicted = yield* Anonymous.executionId({ value: "agreed" })
      const executionId = yield* Anonymous.execute({ value: "agreed" }, { discard: true })
      expect(executionId).toBe(predicted)
    }).pipe(Effect.provide(AnonymousLayer)))

  effect("dies before engine invocation when the payload has no canonical form", () => {
    const Unreached = Action.make("ExecutionId/unreached", {
      payload: { value: Schema.String },
      success: Schema.String
    })
    const Uncanonical = Flow.make("ExecutionId/Uncanonical", {
      payload: { value: Schema.String },
      success: Schema.String,
      body: ({ value }) => Unreached.call({ value })
    })
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Unreached.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Uncanonical)
      )
    )

    return Effect.gen(function*() {
      // RFC 8785 has no form for a lone surrogate, so this invocation has no
      // derivable identity and must not open a run under a guessed one.
      const exit = yield* Uncanonical.execute({ value: "\uD800" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("ExecutionIdRequired")
      expect(invoked).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})
