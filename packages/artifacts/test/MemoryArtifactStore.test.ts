/**
 * The memory and no-op stores: the browser/test tier, and the honest refusal
 * a composition gets when it has no artifact store at all.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "an in-memory artifact"
const digest = sha256(bytes(artifact))

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("makeMemory", () => {
  it.effect("round-trips bytes under their own digest", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      expect(yield* withCrypto(artifacts.put(bytes(artifact)))).toBe(digest)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("is immune to a caller mutating the array it put", () =>
    Effect.gen(function*() {
      // The map is keyed by the digest measured at accept time, so an aliased
      // input array would let a later caller mutation corrupt the stored
      // content for its address. `put` stores a defensive copy instead.
      const artifacts = ArtifactStore.makeMemory()
      const input = bytes(artifact)
      const stored = yield* withCrypto(artifacts.put(input))
      input[0] = 0x58
      expect(text(yield* withCrypto(artifacts.get(stored)))).toBe(artifact)
    }))

  it.effect("is immune to a caller mutating the array it got", () =>
    Effect.gen(function*() {
      // `get` hands out a copy for the same reason: the stored array must never
      // be reachable through a reference a caller can still write to.
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const first = yield* withCrypto(artifacts.get(digest))
      first[0] = 0x58
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("reports a typed miss for an address it never accepted", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      const exit = yield* withCrypto(artifacts.get(digest).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
      expect(yield* withCrypto(artifacts.has(digest))).toBe(false)
    }))

  it.effect("refuses an address that is not usable as one", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(ArtifactStore.makeMemory().get("").pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
    }))

  it.effect("returns a deduplicated subset from findMissing", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const absent = sha256(bytes("never stored"))
      expect(yield* withCrypto(artifacts.findMissing([digest, absent, absent]))).toEqual([absent])
    }))

  it.effect("layerMemory provides it under the tag", () =>
    Effect.gen(function*() {
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
          Effect.provide(ArtifactStore.layerMemory)
        )
      )
      expect(published).toBe(digest)
    }))
})

describe("makeNoop", () => {
  it.effect("fails every operation as unavailable", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeNoop()
      const exits: Array<Exit.Exit<unknown, unknown>> = [
        yield* withCrypto(artifacts.put(bytes(artifact)).pipe(Effect.exit)),
        yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)),
        yield* withCrypto(artifacts.has(digest).pipe(Effect.exit)),
        yield* withCrypto(artifacts.findMissing([digest]).pipe(Effect.exit))
      ]
      for (const exit of exits) {
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
      }
    }))

  it.effect("takes per-method overrides", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeNoop({ has: () => Effect.succeed(true) })
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("layerNoop provides it under the tag", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.has(digest)).pipe(
          Effect.provide(ArtifactStore.layerNoop()),
          Effect.exit
        )
      )
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
    }))
})
