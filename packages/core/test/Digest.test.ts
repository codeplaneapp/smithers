import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, it } from "@effect/vitest"
import { Canonical } from "@smthrs/canonical"
import * as Digest from "@smthrs/core/Digest"
import { Sha256 } from "@smthrs/crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"

// The whole point of this module is that its synchronous digest is the *same*
// digest the injected Crypto service computes. A drift here would silently
// split the agent side's fingerprints from the main tree's keys, so every
// assertion below compares the two paths rather than a checked-in constant.

const platform = <A, E>(effect: Effect.Effect<A, E, never | import("effect/Crypto").Crypto>) =>
  Effect.provide(effect, NodeCrypto.layer)

const vectors: ReadonlyArray<string> = [
  "",
  "abc",
  // 55, 56, and 64 bytes: the block-padding boundaries a hand-written SHA-256
  // gets wrong before it gets anything else wrong.
  "a".repeat(55),
  "a".repeat(56),
  "a".repeat(64),
  "a".repeat(1000),
  "héllo wörld — 🌍",
  JSON.stringify({ flows: "key-material", nested: [1, 2, { deep: true }] })
]

describe("Digest", () => {
  it.effect("agrees with @smthrs/crypto's Sha256 under the platform Crypto layer", () =>
    platform(Effect.gen(function*() {
      const decode = Schema.decodeUnknownEffect(Sha256)
      for (const vector of vectors) {
        const injected = yield* decode(vector)
        expect(Digest.digest(vector)).toBe(injected)
      }
    })))

  it.effect("agrees with the injected service on raw bytes too", () =>
    platform(Effect.gen(function*() {
      const bytes = new Uint8Array(257)
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) % 256
      const injected = yield* Schema.decodeUnknownEffect(Sha256)(bytes)
      expect(Digest.digest(bytes)).toBe(injected)
    })))

  it.effect("agrees with @smthrs/canonical on RFC 8785 serialization", () =>
    platform(Effect.gen(function*() {
      const value = { b: 1, a: [1, 2, { z: null, y: "ü" }], c: { nested: true } }
      const injected = yield* Schema.decodeUnknownEffect(Canonical)(value)
      expect(Digest.canonical(value)).toBe(injected)
    })))

  it.effect("runs an Effect-shaped hashing program synchronously", () =>
    Effect.sync(() => {
      const key = Digest.runSync(Schema.decodeUnknownEffect(Sha256)("abc"))
      expect(key).toBe(Digest.digest("abc"))
    }))

  it.effect("refuses to invent randomness", () =>
    Effect.sync(() => {
      expect(() => Digest.crypto.nextIntUnsafe()).toThrow(/SHA-256 only/)
    }))
})
