import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const nodeDuration = Metric.histogram("smithers.node.duration_ms", durationBuckets);
