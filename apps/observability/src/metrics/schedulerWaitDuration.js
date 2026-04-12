import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const schedulerWaitDuration = Metric.histogram("smithers.scheduler.wait_duration_ms", durationBuckets);
