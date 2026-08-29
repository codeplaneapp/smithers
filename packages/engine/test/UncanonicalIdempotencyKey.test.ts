// Deep reviewed and polished by a human on 2026-08-10.

import type * as Crypto from "effect/Crypto"
/**
 * Issue #151: forcing key-schema decoders at the four derivation sites turned
 * a typed canonicalization error into an untyped defect that
 * killed the fiber. The caller-owned sites now surface a typed, non-retryable
 * `Action.UncanonicalIdempotencyKey` naming the offending path (delivered
 * through the recorded completion exit, the same channel RetryPolicy's
 * typed terminal errors use), and the engine-generated ordinal sites go
 * through `StepIdentity.invocationKey`, which preserves the typed error for the
 * impossible invariant violation instead of discarding it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as StepIdentity from "@smthrs/flow/StepIdentity"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { invocationKey, runSync, withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const identityWith = (body: unknown): Action.IdempotencyKey => ({ body } as Action.IdempotencyKey)

const dieOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isDieReason)
  return reason?.defect
}

const runRejected = (tier: "sealed" | "compensable", body: unknown) => {
  let executions = 0
  const action = Action.make({
    name: `Uncanonical/${tier}`,
    success: Schema.Number,
    tier,
    idempotencyKey: identityWith(body),
    execute: Effect.sync(() => {
      executions++
      return 1
    })
  })
  const flowActionDeclaration = Action.make(`Uncanonical/${tier}-flow` + "/action", {
    payload: { id: Schema.String },
    success: Schema.Number
  })
  const flow = Flow.make(`Uncanonical/${tier}-flow`, {
    payload: { id: Schema.String },
    success: Schema.Number,
    body: (payload) => flowActionDeclaration.call(payload)
  })
  const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return Effect.gen(function*() {
    const exit = yield* flow.execute({ id: "x" }, { executionId: `run-${tier}` }).pipe(Effect.exit)
    return { exit, executions }
  }).pipe(Effect.provide(layer))
}

describe("rejected declaration material surfaces typed, not as fiber death (issue #151)", () => {
  effect("non-JSON object identity fails typed", () =>
    Effect.gen(function*() {
      const outcome = yield* runRejected("sealed", { count: 1n })
      const defect = dieOf(outcome.exit)
      expect(defect).toBeInstanceOf(Action.UncanonicalIdempotencyKey)
      const error = defect as Action.UncanonicalIdempotencyKey
      expect(error.code).toBe("uncanonical_idempotency_key")
      expect(error.actionName).toBe("Uncanonical/sealed")
      expect(error.reason).toBe("canonicalize_failed")
      expect(error.path).toBe("$")
      expect(outcome.executions).toBe(0)
    }))
})

describe("StepIdentity typed derivations (issue #151)", () => {
  it("allocationScope returns a typed SchemaError for rejected JSON material", () => {
    const error = runSync(Effect.flip(StepIdentity.allocationScope({
      kind: "action",
      name: "op",
      idempotency: identityWith({ count: 1n })
    })))
    expect(error._tag).toBe("SchemaError")
  })

  it("allocationScope stays total for string and absent idempotency material", () => {
    const keyless = runSync(StepIdentity.allocationScope({ kind: "internal", name: "op" }))
    const keyed = runSync(StepIdentity.allocationScope({
      kind: "internal",
      name: "op",
      idempotency: "queue:orders"
    }))
    expect(keyless).toBe("internal/2:op")
    expect(keyed).toMatch(/^internal\/2:op\/s:/)
  })

  it("invocationKey preserves the typed CanonicalizeError on the impossible invariant violation", () => {
    expect(runSync(Effect.flip(StepIdentity.invocationKey({
      runId: "run",
      ordinal: Number.POSITIVE_INFINITY,
      tier: "unsealed"
    })))).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    expect(runSync(StepIdentity.invocationKey({ runId: "run", ordinal: 1, tier: "unsealed" }))).toBe(
      invocationKey({ runId: "run", ordinal: 1, tier: "unsealed" })
    )
  })
})
