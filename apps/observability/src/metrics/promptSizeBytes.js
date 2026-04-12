import { Metric } from "effect";
import { sizeBuckets } from "./_buckets.js";
export const promptSizeBytes = Metric.histogram("smithers.prompt.size_bytes", sizeBuckets);
