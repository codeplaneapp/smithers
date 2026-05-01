import { Metric, MetricBoundaries } from "effect";

const toolBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

/** @type {import("effect").Metric.Metric<import("effect/MetricKeyType").MetricKeyType.Histogram, number, import("effect/MetricState").MetricState.Histogram>} */
export const openApiToolDuration = Metric.histogram("smithers.openapi.tool_duration_ms", toolBuckets);
