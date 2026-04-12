import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const timerDelayDuration = Metric.histogram("smithers.timers.delay_ms", durationBuckets);
