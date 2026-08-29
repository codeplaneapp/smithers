/**
 * The artifact counters: successful puts and gets land in the registry the
 * caller provided; typed failures deliberately do not.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactStoreMetrics from "../src/ArtifactStoreMetrics.ts"
import { bytes, withCrypto } from "./Crypto.ts"

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

describe("ArtifactStoreMetrics", () => {
  it.effect("counts successful puts and gets through the provided registry", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(
        Effect.gen(function*() {
          const digest = yield* artifacts.put(bytes("a counted artifact"))
          yield* artifacts.put(bytes("a counted artifact"))
          yield* artifacts.get(digest)
          // A miss fails with its typed error and is deliberately not counted.
          yield* Effect.flip(artifacts.get("0".repeat(64)))

          expect(yield* count(ArtifactStoreMetrics.puts)).toBe(2)
          expect(yield* count(ArtifactStoreMetrics.gets)).toBe(1)
        }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
      )
    }))
})
