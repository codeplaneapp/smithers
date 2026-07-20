import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const approvalWaitDuration = Metric.histogram("smithers.approval.wait_duration_ms", durationBuckets);
