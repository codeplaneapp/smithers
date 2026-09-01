// Deep reviewed and polished by a human on 2026-08-31.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Cause, Crypto, Effect, Exit, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

const provideCrypto = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto>
): Effect.Effect<A, E> => Effect.provide(effect, NodeCrypto.layer)

const derive = (input: unknown): Keys.KeyV1 => Effect.runSync(provideCrypto(Keys.deriveKey(input)))

const decodeCompatibilitySchema = (input: unknown): Keys.Key =>
  Effect.runSync(provideCrypto(Schema.decodeUnknownEffect(Keys.Key)(input)))

const failingCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: () =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "test-host",
        method: "digest"
      }))
  })
)

describe("stored key validation", () => {
  const stored = `key1_${"a".repeat(64)}`

  it("parses a supported stored key unchanged without Crypto", () => {
    expect(Schema.decodeUnknownSync(Keys.StoredKey)(stored)).toBe(stored)
    expect(Schema.decodeUnknownSync(Keys.KeyV1)(stored)).toBe(stored)
    expect(Schema.decodeUnknownSync(Keys.Key.StoredKey)(stored)).toBe(stored)
    expect(Schema.decodeUnknownSync(Keys.Key.KeyV1)(stored)).toBe(stored)
    expect(Keys.digest(Schema.decodeUnknownSync(Keys.StoredKey)(stored))).toBe("a".repeat(64))
    expect(Keys.Key.digest(Schema.decodeUnknownSync(Keys.StoredKey)(stored))).toBe("a".repeat(64))
  })

  it("keeps parsing separate from deriving a key from key-shaped text", () => {
    const parsed = Schema.decodeUnknownSync(Keys.StoredKey)(stored)
    expect(parsed).toBe(stored)
    expect(derive(stored)).not.toBe(parsed)
    expect(decodeCompatibilitySchema(stored)).toBe(derive(stored))
  })

  it("rejects unsupported versions and malformed wire values", () => {
    for (
      const value of [
        `key2_${"a".repeat(64)}`,
        `key0_${"a".repeat(64)}`,
        `key01_${"a".repeat(64)}`,
        `key1_${"A".repeat(64)}`,
        `key1_${"a".repeat(63)}`,
        `key1_${"a".repeat(65)}`,
        "key1_invalid",
        "",
        null,
        1,
        {}
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Keys.StoredKey)(value)).toThrow()
    }
  })

  it("keeps Schema.toType(Key) as a compatibility view of the stored schema", () => {
    expect(Schema.decodeUnknownSync(Schema.toType(Keys.Key))(stored)).toBe(stored)
  })
})

describe("key derivation", () => {
  it.each([
    [null, "key1_74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
    [{ b: 2, a: 1 }, "key1_43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
    [{ text: "λ" }, "key1_195d9a15927fe2bd86e32921e890c4a06362e93114b6aba2188499350682611f"],
    ["", "key1_12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126"]
  ])("matches the frozen key1 wire vector for %#", (input, expected) => {
    expect(derive(input)).toBe(expected)
    expect(decodeCompatibilitySchema(input)).toBe(expected)
  })

  it("derives the same key from canonically equivalent JSON", () => {
    expect(derive({ b: 2, a: 1 })).toBe(derive({ a: 1, b: 2 }))
  })

  it("keeps known distinct canonical values distinct", () => {
    expect(derive({ value: 1 })).not.toBe(derive({ value: "1" }))
    expect(derive([1, 2])).not.toBe(derive([2, 1]))
  })

  it("returns a typed canonicalization failure with its cause", () => {
    const error = Effect.runSync(Effect.flip(provideCrypto(
      Keys.deriveKey({ value: 1n })
    )))
    expect(error).toBeInstanceOf(Keys.KeyDerivationError)
    expect(error).toMatchObject({
      _tag: "@smthrs/keys/KeyDerivationError",
      code: "canonicalization_failed",
      message: "Key input could not be canonicalized",
      cause: expect.objectContaining({ _tag: "SchemaError" })
    })
  })

  it("returns a typed digest failure with the crypto cause chain", () => {
    const error = Effect.runSync(Effect.flip(
      Effect.provide(Keys.Key.derive({ operation: "compile" }), failingCrypto)
    ))
    expect(error).toBeInstanceOf(Keys.KeyDerivationError)
    expect(error).toMatchObject({
      code: "digest_failed",
      message: "Canonical key material could not be hashed",
      cause: expect.objectContaining({
        _tag: "@smthrs/crypto/Sha256Error",
        code: "digest_failed"
      })
    })
  })

  it("redacts key material from schema failures", () => {
    const secret = "key-material-that-must-not-appear"
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Keys.Key)({ secret }).pipe(
        Effect.provide(failingCrypto)
      )
    ))
    expect(error.message).toContain("[digest_failed] Canonical key material could not be hashed")
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expect(error.issue).toMatchObject({
      issue: {
        annotations: {
          code: "digest_failed",
          cause: expect.objectContaining({
            _tag: "@smthrs/keys/KeyDerivationError"
          })
        }
      }
    })
  })

  it("redacts non-canonical key material even when input reporting is requested", () => {
    const secret = "canonical-secret-that-must-not-appear"
    const error = Effect.runSync(Effect.flip(
      provideCrypto(
        Schema.decodeUnknownEffect(Keys.Key)({ [secret]: 1n }, { reportInput: true })
      )
    ))
    expect(error.message).toContain("[canonicalization_failed] Key input could not be canonicalized")
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
    expect(error.issue).toMatchObject({
      issue: {
        annotations: {
          code: "canonicalization_failed",
          cause: expect.objectContaining({
            _tag: "@smthrs/keys/KeyDerivationError",
            cause: expect.objectContaining({ _tag: "SchemaError" })
          })
        }
      }
    })
  })

  it("reports a missing Crypto service as an Effect configuration defect", () => {
    const exit = Effect.runSyncExit(Keys.deriveKey({ operation: "compile" }) as Effect.Effect<never, never>)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("Service not found: effect/Crypto")
    }
  })

  it("cannot reconstruct its input", () => {
    const key = derive({ operation: "compile" })
    const typed = Effect.runSync(Effect.flip(Schema.encodeEffect(Keys.Key)(key)))
    expect(typed._tag).toBe("SchemaError")
    expect(typed.message).toContain("A key cannot be converted back into its input")

    const raw = Effect.runSync(
      Effect.flip(Schema.encodeUnknownEffect(Keys.Key)(`key1_${"a".repeat(64)}`))
    )
    expect(raw._tag).toBe("SchemaError")
  })

  it("always emits the fixed key1 width", () => {
    for (const input of [null, "", false, 0, [], {}, { nested: [1, 2, 3] }]) {
      const key = derive(input)
      expect(key).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(key).toHaveLength(69)
    }
  })

  describe("canonical erasure inherited from Canonical", () => {
    it("collapses negative zero into zero", () => {
      expect(derive(-0)).toBe(derive(0))
    })

    it("collapses an undefined-valued member into an absent member", () => {
      expect(derive({ a: 1, b: undefined })).toBe(derive({ a: 1 }))
    })

    it("collapses an undefined array element into null", () => {
      expect(derive([undefined])).toBe(derive([null]))
    })
  })

  describe("structural separation", () => {
    it.each([
      ["a split moved between array elements", ["a", "bc"], ["ab", "c"]],
      ["quotes and commas spelled inside one element", ["a\",\"b"], ["a", "b"]],
      ["a character moved from an object value into its key", { a: "b" }, { ab: "" }],
      ["nesting flattened into a dotted key", { a: { b: 1 } }, { "a.b": 1 }]
    ])("keeps %s distinct", (_name, left, right) => {
      expect(derive(left)).not.toBe(derive(right))
    })

    it("keeps degenerate canonical documents pairwise distinct", () => {
      const keys = [derive(""), derive({}), derive([]), derive(null), derive(0), derive(false)]
      expect(new Set(keys).size).toBe(keys.length)
    })
  })
})
