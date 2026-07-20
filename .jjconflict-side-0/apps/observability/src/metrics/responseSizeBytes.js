import { Metric } from "effect";
import { sizeBuckets } from "./_buckets.js";
export const responseSizeBytes = Metric.histogram("smithers.response.size_bytes", sizeBuckets);
