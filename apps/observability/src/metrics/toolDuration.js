import { Metric } from "effect";
import { toolBuckets } from "./_buckets.js";
export const toolDuration = Metric.histogram("smithers.tool.duration_ms", toolBuckets);
