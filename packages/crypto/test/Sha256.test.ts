// Deep reviewed and polished by a human on 2026-08-10.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect, Layer, PlatformError, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Sha256 } from "../src/index.ts"

const decode = (input: string | Uint8Array): typeof Sha256.Digest.Type =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(NodeCrypto.layer))
  )

const digestFailure = (value: unknown) => Effect.runSync(Effect.flip(Schema.decodeUnknownEffect(Sha256.Digest)(value)))

// Known answers, hardcoded. A digest is an identity that crosses the journal
// and the cache, so the test has to pin the algorithm to published constants.
// Recomputing the expectation with `node:crypto` at run time would only assert
// that two callers of the same host primitive agree, and would keep passing if
// the transformation started hashing the wrong bytes in the same way twice.
//
// The first two are the FIPS 180-4 / RFC 6234 vectors for the empty input and
// "abc". The last two are SHA-256 over the UTF-8 encodings of U+00E9
// (0xc3 0xa9) and U+1F600 (0xf0 0x9f 0x98 0x80), which is what pins that text
// input is UTF-8 encoded rather than UTF-16 or Latin-1.
const EMPTY_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const ABC_DIGEST = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
const E_ACUTE_DIGEST = "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"
const GRINNING_FACE_DIGEST = "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"

describe("Sha256", () => {
  it("hashes UTF-8 text and bytes identically", () => {
    expect(decode("hello")).toBe(decode(new TextEncoder().encode("hello")))
  })

  it("produces a validated lowercase digest", () => {
    const digest = decode("hello")
    expect(Schema.decodeUnknownSync(Sha256.Digest)(digest)).toBe(digest)
    expect(() => Schema.decodeUnknownSync(Sha256.Digest)("abc")).toThrow()
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
      Schema.decodeUnknownEffect(Sha256)("hello"),
      failingCrypto
    )))
    expect(error._tag).toBe("SchemaError")
  })

  it("cannot reconstruct its input", () => {
    const digest = decode("hello")
    expect(Effect.runSync(Effect.flip(Schema.encodeEffect(Sha256)(digest)))._tag).toBe("SchemaError")
  })
})

describe("known-answer vectors", () => {
  it.each([
    ["the empty string", "", EMPTY_DIGEST],
    ["\"abc\"", "abc", ABC_DIGEST]
  ])("hashes %s to its published vector", (_name, input, expected) => {
    expect(decode(input)).toBe(expected)
  })

  it.each([
    ["zero bytes", new Uint8Array(0), EMPTY_DIGEST],
    ["the bytes of \"abc\"", new Uint8Array([0x61, 0x62, 0x63]), ABC_DIGEST]
  ])("hashes %s to the same published vector", (_name, input, expected) => {
    expect(decode(input)).toBe(expected)
  })

  it("agrees between the empty string and a zero-length Uint8Array", () => {
    // The two arms of the input union have to meet at the empty input, or a
    // caller that already holds bytes would key the same work differently from
    // one that holds the equivalent text.
    expect(decode("")).toBe(decode(new Uint8Array(0)))
    expect(decode("")).toBe(EMPTY_DIGEST)
  })

  it.each([
    ["U+00E9, a two-byte UTF-8 sequence", "\u00e9", E_ACUTE_DIGEST],
    ["U+1F600, a four-byte UTF-8 sequence outside the BMP", "\ud83d\ude00", GRINNING_FACE_DIGEST]
  ])("hashes %s as UTF-8", (_name, input, expected) => {
    expect(decode(input)).toBe(expected)
  })

  it("hashes a lone surrogate as the replacement character", () => {
    // `TextEncoder` has no UTF-8 encoding for a lone surrogate and substitutes
    // U+FFFD, so the two inputs collide. That collision is accepted at this
    // layer: this module hashes whatever bytes it is handed, and `Canonical` is
    // the gate that refuses a lone surrogate before a digest is taken over it.
    expect(decode("\ud800")).toBe(decode("\ufffd"))
  })

  it("hashes only the window of a non-zero-offset subarray", () => {
    // A subarray shares its backing buffer. Hashing `buffer` instead of the
    // view would fold the surrounding padding into the digest, so a sliced view
    // must equal a tight copy of the same three bytes.
    const backing = new Uint8Array([0xff, 0xff, 0xff, 0x61, 0x62, 0x63, 0xff, 0xff])
    const view = backing.subarray(3, 6)
    expect(view.byteOffset).toBe(3)
    expect(decode(view)).toBe(decode(new Uint8Array(view)))
    expect(decode(view)).toBe(ABC_DIGEST)
  })
})

describe("Sha256.Digest boundaries", () => {
  it("accepts sixty-four lowercase hexadecimal characters", () => {
    const zeros = "0".repeat(64)
    expect(Schema.decodeUnknownSync(Sha256.Digest)(zeros)).toBe(zeros)
  })

  it.each([
    // Uppercase is REJECTED: the digest is a lowercase-hex identity, so two
    // spellings of the same bytes must never both be storable.
    ["sixty-four uppercase hexadecimal characters", EMPTY_DIGEST.toUpperCase()],
    ["one character short", "0".repeat(63)],
    ["one character long", "0".repeat(65)],
    ["sixty-four non-hexadecimal characters", "g".repeat(64)],
    ["leading whitespace", ` ${"0".repeat(64)}`],
    ["trailing whitespace", `${"0".repeat(64)} `]
  ])("rejects %s", (_name, value) => {
    const error = digestFailure(value)
    expect(error._tag).toBe("SchemaError")
    expect(error.message).toContain("^[0-9a-f]{64}$")
  })
})
