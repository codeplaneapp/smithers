import { Metric } from "effect";
import { fastBuckets } from "./_buckets.js";
export const httpRequestDuration = Metric.histogram("smithers.http.request_duration_ms", fastBuckets);
