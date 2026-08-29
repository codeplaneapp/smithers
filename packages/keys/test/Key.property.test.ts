import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Canonical } from "@smthrs/canonical/Canonical"
import { Effect, Result, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const attemptKey = (value: unknown): Result.Result<string, Schema.SchemaError> =>
  Effect.runSync(
    Effect.result(Schema.decodeUnknownEffect(Keys.Key)(value)).pipe(Effect.provide(NodeCrypto.layer))
  )

const attemptCanonical = (value: unknown): Result.Result<string, Schema.SchemaError> =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(Canonical)(value)))

describe("Key properties", () => {
  it("derives a deterministic fixed-width key or fails typed, for arbitrary JSON", () => {
    // Equal inputs must produce byte-identical keys of the invariant shape
    // `key1_` + 64 lowercase hex, whatever the input size or content; inputs
    // with no canonical form must fail with a typed SchemaError both times.
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: "binary" }), (value) => {
        const first = attemptKey(value)
        const second = attemptKey(value)
        if (Result.isFailure(first)) {
          expect(first.failure._tag).toBe("SchemaError")
          expect(Result.isFailure(second)).toBe(true)
          return
        }
        expect(first.success).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(first.success.length).toBe(69)
        expect(Result.isSuccess(second) ? second.success : undefined).toBe(first.success)
      }),
      { ...params, examples: [[-0], [""], [{}], [[]], [{ "\ud800": 1 }]] }
    )
  })

  it("is injective exactly up to canonical equality", () => {
    // The key is a digest of the RFC 8785 document, so two values collide if
    // and only if their canonical documents are byte-identical. Known
    // erasures (-0 → 0, dropped undefined members) are contract: they produce
    // the same document, so they must produce the same key. Everything else
    // must stay distinct — a collision here would cross-wire the step cache.
    const json = FastCheck.jsonValue({ stringUnit: "binary" })
    FastCheck.assert(
      FastCheck.property(json, json, (left, right) => {
        const leftCanonical = attemptCanonical(left)
        const rightCanonical = attemptCanonical(right)
        if (Result.isFailure(leftCanonical) || Result.isFailure(rightCanonical)) {
          // No canonical form means no key either, on the same side.
          const failing = Result.isFailure(leftCanonical) ? left : right
          expect(Result.isFailure(attemptKey(failing))).toBe(true)
          return
        }
        const leftKey = attemptKey(left)
        const rightKey = attemptKey(right)
        expect(Result.isSuccess(leftKey)).toBe(true)
        expect(Result.isSuccess(rightKey)).toBe(true)
        if (Result.isSuccess(leftKey) && Result.isSuccess(rightKey)) {
          if (leftCanonical.success === rightCanonical.success) {
            expect(leftKey.success).toBe(rightKey.success)
          } else {
            expect(leftKey.success).not.toBe(rightKey.success)
          }
        }
      }),
      {
        ...params,
        examples: [
          [-0, 0],
          [["a", "bc"], ["ab", "c"]],
          [{ a: "b" }, { ab: "" }],
          [{ a: { b: 1 } }, { "a.b": 1 }],
          [{ b: 2, a: 1 }, { a: 1, b: 2 }],
          [1e21, "1e+21"]
        ]
      }
    )
  })
})
