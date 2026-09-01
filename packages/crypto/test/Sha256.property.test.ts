import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Crypto, Effect } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import { digest, digestSync, syncCrypto } from "../src/index.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const runDigest = (input: string | Uint8Array) => Effect.runSync(digest(input).pipe(Effect.provide(NodeCrypto.layer)))

const runSynchronousService = (input: string | Uint8Array) =>
  Effect.runSync(Effect.provideService(digest(input), Crypto.Crypto, syncCrypto))

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

describe("SHA-256 properties", () => {
  it("keeps injected, synchronous, and UTF-8 byte hashing equivalent", () => {
    const encoder = new TextEncoder()
    FastCheck.assert(
      FastCheck.property(FastCheck.string({ unit: "binary" }), (text) => {
        if (!isWellFormed(text)) {
          expect(() => digestSync(text)).toThrow(expect.objectContaining({ code: "invalid_text" }))
          expect(Effect.runSync(Effect.flip(
            Effect.provideService(digest(text), Crypto.Crypto, syncCrypto)
          ))).toMatchObject({ code: "invalid_text" })
          return
        }
        const expected = digestSync(text)
        expect(expected).toMatch(/^[0-9a-f]{64}$/)
        expect(digestSync(encoder.encode(text))).toBe(expected)
        expect(runDigest(text)).toBe(expected)
        expect(runSynchronousService(text)).toBe(expected)
      }),
      { ...params, examples: [[""], ["\ud800"], ["\ud83d\ude00"], ["\ufffd"], ["\0"]] }
    )
  })

  it("hashes exactly the viewed bytes through every entry point", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.uint8Array(),
        FastCheck.uint8Array(),
        FastCheck.uint8Array(),
        (bytes, prefix, suffix) => {
          const backing = new Uint8Array(prefix.length + bytes.length + suffix.length)
          backing.set(prefix)
          backing.set(bytes, prefix.length)
          backing.set(suffix, prefix.length + bytes.length)
          const view = backing.subarray(prefix.length, prefix.length + bytes.length)
          const expected = digestSync(bytes)
          expect(digestSync(view)).toBe(expected)
          expect(runDigest(view)).toBe(expected)
        }
      ),
      {
        ...params,
        examples: [
          [new Uint8Array(0), new Uint8Array([0xff]), new Uint8Array([0xff])],
          [new Uint8Array([0x61, 0x62, 0x63]), new Uint8Array([0xff]), new Uint8Array([0xff])]
        ]
      }
    )
  })
})
