import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const runDuration = Metric.histogram("smithers.run.duration_ms", durationBuckets);
