import { Metric } from "effect";

const snapshotBuckets = Metric.exponentialBoundaries({
  start: 1,
  factor: 2,
  count: 12,
}); // ~1ms to ~2s

export const snapshotDuration = Metric.histogram("smithers.snapshot.duration_ms", { boundaries: snapshotBuckets });
