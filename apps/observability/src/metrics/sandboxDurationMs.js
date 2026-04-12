import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const sandboxDurationMs = Metric.histogram("smithers.sandbox.duration_ms", durationBuckets);
