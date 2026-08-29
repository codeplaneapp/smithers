// Deep reviewed and polished by a human on 2026-08-10.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/index.ts"

describe("Key", () => {
  const provideCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
    Effect.provide(effect, NodeCrypto.layer)
  const decode = (input: unknown): Keys.Key =>
    Effect.runSync(provideCrypto(Schema.decodeUnknownEffect(Keys.Key)(input)))

  it("derives the same key from canonically equivalent JSON", () => {
    expect(decode({ b: 2, a: 1 })).toBe(decode({ a: 1, b: 2 }))
  })

  it("keeps distinct JSON values distinct", () => {
    expect(decode({ value: 1 })).not.toBe(decode({ value: "1" }))
    expect(decode([1, 2])).not.toBe(decode([2, 1]))
  })

  it("produces a validated versioned key", () => {
    const key = decode({ operation: "compile", version: 1 })
    expect(Schema.decodeUnknownSync(Schema.toType(Keys.Key))(key)).toBe(key)
    expect(() => Schema.decodeUnknownSync(Schema.toType(Keys.Key))("key1_invalid")).toThrow()
  })

  it("reports non-canonicalizable inputs as schema errors", () => {
    const error = Effect.runSync(Effect.flip(provideCrypto(Schema.decodeUnknownEffect(Keys.Key)({ value: 1n }))))
    expect(error._tag).toBe("SchemaError")
  })

  it("reports crypto failures as schema errors", () => {
    const failingCrypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "Unknown",
            module: "test",
            method: "digest"
          }))
      })
    )
    const error = Effect.runSync(Effect.flip(Effect.provide(
      Schema.decodeUnknownEffect(Keys.Key)({ operation: "compile" }),
      failingCrypto
    )))
    expect(error._tag).toBe("SchemaError")
  })

  it("cannot reconstruct its input", () => {
    const key = decode({ operation: "compile" })
    expect(Effect.runSync(Effect.flip(Schema.encodeEffect(Keys.Key)(key)))._tag).toBe("SchemaError")
  })

  it("refuses to encode a key back to its input through encodeUnknown", () => {
    // `SchemaGetter.forbidden` is the only thing stopping a `Key` from being
    // turned back into the value that produced it, and `Schema.encodeUnknown`
    // is the entry point that reaches it without the caller already holding a
    // typed `Key`. The cell above covers `encodeEffect`; this covers the
    // untyped door, which is the one an outside caller finds first.
    const key = decode({ operation: "compile" })

    const typed = Effect.runSync(Effect.flip(Schema.encodeUnknownEffect(Keys.Key)(key)))
    expect(typed._tag).toBe("SchemaError")
    expect(typed.message).toContain("A key cannot be converted back into its input")

    // A raw string in the key's storage form is refused the same way: the
    // forbidden getter runs after the brand check, so nothing gets through by
    // spelling a well-formed key.
    const raw = Effect.runSync(
      Effect.flip(Schema.encodeUnknownEffect(Keys.Key)(`key1_${"a".repeat(64)}`))
    )
    expect(raw._tag).toBe("SchemaError")
  })

  describe("canonical erasure", () => {
    // A key is a digest of the canonical form, so anything the canonical form
    // drops becomes a deliberate collision. Each cell below names one, so a
    // caller that needs the distinction knows to encode it into the value.

    it("collapses negative zero into zero", () => {
      // RFC 8785 numbers are `JSON.stringify` numbers, and `-0` serializes as
      // `0`: the sign of zero is erased before hashing.
      expect(decode(-0)).toBe(decode(0))
    })

    it("collapses an undefined-valued member into an absent member", () => {
      // `undefined` has no JSON representation, so the member is dropped and
      // the object collides with the one that never carried it.
      expect(decode({ a: 1, b: undefined })).toBe(decode({ a: 1 }))
    })

    it("collapses an undefined array element into null", () => {
      // An array cannot drop an element without changing its length, so
      // `undefined` becomes `null` and the two arrays collide.
      expect(decode([undefined])).toBe(decode([null]))
    })
  })

  describe("injection resistance", () => {
    // Concatenating a value's parts into one string before hashing is the
    // classic key-derivation bug, and `["a","bc"]` versus `["ab","c"]` is its
    // canonical witness. Hashing the canonical document instead keeps the
    // structure inside the digest: the JSON delimiters, and the escaping of a
    // delimiter that appears inside a value, are both part of the hashed bytes.
    it.each([
      ["a split moved between array elements", ["a", "bc"], ["ab", "c"]],
      ["quotes and commas spelled inside one element", ["a\",\"b"], ["a", "b"]],
      ["a character moved from an object value into its key", { a: "b" }, { ab: "" }],
      ["nesting flattened into a dotted key", { a: { b: 1 } }, { "a.b": 1 }]
    ])("keeps %s distinct", (_name, left, right) => {
      expect(decode(left)).not.toBe(decode(right))
    })
  })

  it("keeps every degenerate empty or falsy value pairwise distinct", () => {
    // These are the values most likely to be conflated by a derivation that
    // stringifies loosely before hashing: each has its own canonical document
    // (`""`, `{}`, `[]`, `null`, `0`, `false`), so each must have its own key.
    const keys = [decode(""), decode({}), decode([]), decode(null), decode(0), decode(false)]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("produces a fixed-length key regardless of input size", () => {
    // A key names a cache entry and an attempt row, so its width has to be
    // independent of the value it was derived from.
    const key = decode("x".repeat(5 * 1024 * 1024))
    expect(key).toMatch(/^key1_[0-9a-f]{64}$/)
    expect(key.length).toBe(69)
  })

  it("decodes a key2_ key, which the version marker promises stays readable", () => {
    // The module docblock: "A future derivation gets `key2_`, and both remain
    // decodable, so a stored key never becomes ambiguous about which scheme
    // produced it." The storage pattern therefore accepts any version marker,
    // while fresh derivation stays pinned to `key1_`.
    const key2 = `key2_${"a".repeat(64)}`
    expect(Schema.decodeUnknownSync(Schema.toType(Keys.Key))(key2)).toBe(key2)
  })

  it("still refuses a key with no version at all", () => {
    // `key0_`, a bare `key_`, and a marker with a leading zero are not
    // versions the scheme has ever minted, so accepting them would let a
    // corrupted value masquerade as a key.
    for (const spelled of ["key0_", "key_", "key01_"]) {
      expect(() => Schema.decodeUnknownSync(Schema.toType(Keys.Key))(`${spelled}${"a".repeat(64)}`)).toThrow()
    }
  })
})
