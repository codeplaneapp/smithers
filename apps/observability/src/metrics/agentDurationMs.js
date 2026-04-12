import { Metric } from "effect";
import { durationBuckets } from "./_buckets.js";
export const agentDurationMs = Metric.histogram("smithers.agent_duration_ms", durationBuckets);
