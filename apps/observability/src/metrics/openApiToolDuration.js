import { Metric } from "effect";

const toolBuckets = Metric.exponentialBoundaries({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

/** @type {import("effect").Metric.Histogram<number>} */
export const openApiToolDuration = Metric.histogram("smithers.openapi.tool_duration_ms", { boundaries: toolBuckets });
