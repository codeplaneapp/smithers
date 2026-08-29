import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as CacheStore from "../src/CacheStore.ts"

describe("service contracts", () => {
  it.effect("constructs and exercises the CacheStore stub", () =>
    Effect.gen(function*() {
      const service = CacheStore.makeNoop()
      const entry: CacheStore.CacheEntry = {
        keyDigest: "digest",
        result: {},
        meta: {},
        createdAtMs: 0,
        recordedRunId: "run",
        recordedEventSeq: 0
      }
      expect((yield* (Effect.flip(service.get("digest")))).message).toContain("get")
      expect((yield* (Effect.flip(service.put(entry)))).message).toContain("put")
      expect((yield* (Effect.flip(service.evict("digest")))).message).toContain("evict")
      expect((yield* (Effect.flip(service.sweepExpired(0)))).message).toContain("sweepExpired")

      const result = yield* (
        Effect.gen(function*() {
          return yield* (yield* CacheStore.CacheStore).get("digest")
        }).pipe(
          Effect.provide(CacheStore.layerNoop({
            get: () => Effect.succeed(Option.none())
          }))
        )
      )
      expect(Option.isNone(result)).toBe(true)
    }))
})
