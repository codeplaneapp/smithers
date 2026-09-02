import { Effect, Metric } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowsMetric from "../src/Metric.ts"

describe("Metric registry", () => {
  it("declares the run, seat, and quota metrics updated by producer seams", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Metric.update(FlowsMetric.runThroughput, 1)
        yield* Metric.update(FlowsMetric.activeSeats, 3)
        yield* Metric.update(FlowsMetric.quotaParks, 2)
        return {
          throughput: yield* Metric.value(FlowsMetric.runThroughput),
          seats: yield* Metric.value(FlowsMetric.activeSeats),
          parks: yield* Metric.value(FlowsMetric.quotaParks)
        }
      })
    )
    expect(result.throughput.count).toBe(1)
    expect(result.seats.value).toBe(3)
    expect(result.parks.count).toBe(2)
    expect(Object.keys(FlowsMetric.registry)).toHaveLength(3)
  })
})
