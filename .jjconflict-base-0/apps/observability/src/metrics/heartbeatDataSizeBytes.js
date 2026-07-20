import { Metric } from "effect";
import { sizeBuckets } from "./_buckets.js";
export const heartbeatDataSizeBytes = Metric.histogram("smithers.heartbeats.data_size_bytes", sizeBuckets);
