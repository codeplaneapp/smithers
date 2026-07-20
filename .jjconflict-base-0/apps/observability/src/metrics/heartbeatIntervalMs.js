import { Metric } from "effect";
import { fastBuckets } from "./_buckets.js";
export const heartbeatIntervalMs = Metric.histogram("smithers.heartbeats.interval_ms", fastBuckets);
