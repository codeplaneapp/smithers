import { Metric } from "effect";

const scorerBuckets = Metric.exponentialBoundaries({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const scorerDuration = Metric.histogram("smithers.scorer.duration_ms", { boundaries: scorerBuckets });
