import { Effect, Metric } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowsMetric from "../src/Metric.ts"

describe("Metric registry", () => {
  it("declares throughput, seats, quota, cache, and hit-rate metrics", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Metric.update(FlowsMetric.runThroughput, 1)
        yield* Metric.update(FlowsMetric.activeSeats, 3)
        yield* Metric.update(FlowsMetric.quotaParks, 2)
        yield* Metric.update(FlowsMetric.cacheHits, 4)
        yield* Metric.update(FlowsMetric.cacheMisses, 1)
        yield* Metric.update(FlowsMetric.cacheHitRate, 0.8)
        return {
          throughput: yield* Metric.value(FlowsMetric.runThroughput),
          seats: yield* Metric.value(FlowsMetric.activeSeats),
          parks: yield* Metric.value(FlowsMetric.quotaParks),
          hits: yield* Metric.value(FlowsMetric.cacheHits),
          misses: yield* Metric.value(FlowsMetric.cacheMisses),
          rate: yield* Metric.value(FlowsMetric.cacheHitRate)
        }
      })
    )
    expect(result.throughput.count).toBe(1)
    expect(result.seats.value).toBe(3)
    expect(result.parks.count).toBe(2)
    expect(result.hits.count).toBe(4)
    expect(result.misses.count).toBe(1)
    expect(result.rate.value).toBe(0.8)
    expect(Object.keys(FlowsMetric.registry)).toHaveLength(6)
  })
})
