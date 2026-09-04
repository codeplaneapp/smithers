import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Digest, digest, digestSync, Sha256, Sha256Error, syncCrypto } from "../src/index.ts"
import { millionA, vectors } from "./fixtures.ts"

const runDigest = (input: string | Uint8Array): Digest =>
  Effect.runSync(digest(input).pipe(Effect.provide(NodeCrypto.layer)))

const decode = (input: string | Uint8Array): Digest =>
  Effect.runSync(Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(NodeCrypto.layer)))

const digestFailure = (input: string | Uint8Array) =>
  Effect.runSync(Effect.flip(Effect.provideService(digest(input), Crypto.Crypto, syncCrypto)))

describe("SHA-256 entry points", () => {
  it.each(vectors)("matches the published vector for %j", (input, expected) => {
    const bytes = new TextEncoder().encode(input)
    expect(digestSync(input)).toBe(expected)
    expect(digestSync(bytes)).toBe(expected)
    expect(runDigest(input)).toBe(expected)
    expect(runDigest(bytes)).toBe(expected)
    expect(decode(input)).toBe(expected)
  })

  it("hashes only a Uint8Array view and snapshots it", () => {
    const backing = new Uint8Array([0xff, 0xff, 0x61, 0x62, 0x63, 0xff])
    const view = backing.subarray(2, 5)
    const effect = digest(view)
    backing.fill(0)

    // Snapshot semantics begin when the Effect executes, so this sees the
    // deliberate pre-execution mutation.
    expect(Effect.runSync(effect.pipe(Effect.provide(NodeCrypto.layer)))).toBe(digestSync(new Uint8Array(3)))

    backing.set([0x61, 0x62, 0x63], 2)
    expect(digestSync(view)).toBe(vectors[1][1])
  })

  it("accepts Node and Bun Buffer as a Uint8Array subclass", () => {
    expect(digestSync(Buffer.from("abc"))).toBe(vectors[1][1])
    expect(runDigest(Buffer.from("abc"))).toBe(vectors[1][1])
    expect(decode(Buffer.from("abc"))).toBe(vectors[1][1])
  })

  it("rejects unpaired surrogates without normalizing valid text", () => {
    for (const input of ["\ud800", "\udfff", `x\ud800y`, `x\udc00y`]) {
      expect(() => digestSync(input)).toThrow(expect.objectContaining({
        _tag: "@smthrs/crypto/Sha256Error",
        code: "invalid_text"
      }))
      expect(digestFailure(input)).toMatchObject({ code: "invalid_text" })
    }

    expect(digestSync("é")).not.toBe(digestSync("e\u0301"))
  })

  it("hashes the million-'a' FIPS vector with the whole-buffer API", () => {
    const input = "a".repeat(1_000_000)
    expect(digestSync(input)).toBe(millionA)
    expect(runDigest(input)).toBe(millionA)
  })

  it("exports Digest directly and through the compatibility namespace", () => {
    const value = vectors[0][1]
    expect(Schema.decodeUnknownSync(Digest)(value)).toBe(value)
    expect(Schema.decodeUnknownSync(Sha256.Digest)(value)).toBe(value)
    expect(Sha256.digestSync("abc")).toBe(vectors[1][1])
    expect(Sha256.digest).toBe(digest)
  })
})

describe("Digest validation and one-way schema behavior", () => {
  it.each([
    vectors[0][1].toUpperCase(),
    "0".repeat(63),
    "0".repeat(65),
    "g".repeat(64),
    ` ${"0".repeat(64)}`,
    `${"0".repeat(64)} `,
    42,
    null
  ])("rejects invalid digest %j", (value) => {
    expect(() => Schema.decodeUnknownSync(Digest)(value)).toThrow()
  })

  it.each([
    new ArrayBuffer(3),
    new DataView(new ArrayBuffer(3)),
    new Uint16Array(3),
    [1, 2, 3],
    { bytes: [1, 2, 3] }
  ])(
    "rejects unsupported hash input %j",
    (value) => {
      expect(Effect.runSync(Effect.flip(
        Schema.decodeUnknownEffect(Sha256)(value).pipe(Effect.provideService(Crypto.Crypto, syncCrypto))
      ))).toMatchObject({ _tag: "SchemaError" })
      expect(() => digestSync(value as never)).toThrow(expect.objectContaining({ code: "invalid_input" }))
    }
  )

  it("redacts values rejected by the input schema", () => {
    const secret = "unsupported-input-secret"
    const error = Effect.runSync(Effect.flip(
      Schema.decodeUnknownEffect(Sha256)({ secret }, { reportInput: true }).pipe(
        Effect.provideService(Crypto.Crypto, syncCrypto)
      )
    ))
    expect(error.message).not.toContain(secret)
    expect(error.issue).not.toHaveProperty("actual")
  })

  it("uses the exact forbidden-encode message", () => {
    const error = Effect.runSync(Effect.flip(Schema.encodeEffect(Sha256)(vectors[0][1] as Digest)))
    const message = "A digest cannot be converted back into its source bytes"
    expect(error.message).toContain(message)
    expect(error.issue).toMatchObject({ issue: { annotations: { message } } })
  })

  it("preserves text-encoding failures without retaining the input", () => {
    const cause = new Error("encoder unavailable")
    const original = TextEncoder.prototype.encode
    TextEncoder.prototype.encode = () => {
      throw cause
    }
    try {
      expect(() => digestSync("secret-text")).toThrow(expect.objectContaining({
        code: "text_encoding_failed",
        cause
      }))
      const error = digestFailure("secret-text")
      expect(error).toBeInstanceOf(Sha256Error)
      expect(error).toMatchObject({ code: "text_encoding_failed", cause })
      expect(error.message).not.toContain("secret-text")
    } finally {
      TextEncoder.prototype.encode = original
    }
  })

  it("turns a detached byte view into a cause-preserving invalid-input error", () => {
    const bytes = new Uint8Array([1, 2, 3])
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
    expect(() => digestSync(bytes)).toThrow(expect.objectContaining({
      code: "invalid_input",
      message: "SHA-256 byte input could not be copied",
      cause: expect.any(TypeError)
    }))
    expect(digestFailure(bytes)).toMatchObject({
      code: "invalid_input",
      cause: expect.any(TypeError)
    })
  })
})
