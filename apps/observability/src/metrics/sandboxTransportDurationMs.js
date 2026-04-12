import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const sandboxTransportDurationMs = Metric.histogram("smithers.sandbox.transport_duration_ms", durationBuckets);
