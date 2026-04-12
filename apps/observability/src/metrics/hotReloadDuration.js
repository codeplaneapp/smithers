import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const hotReloadDuration = Metric.histogram("smithers.hot.reload_duration_ms", durationBuckets);
