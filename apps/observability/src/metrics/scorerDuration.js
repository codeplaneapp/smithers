import { Metric, MetricBoundaries } from "effect";

const scorerBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const scorerDuration = Metric.histogram("smithers.scorer.duration_ms", scorerBuckets);
