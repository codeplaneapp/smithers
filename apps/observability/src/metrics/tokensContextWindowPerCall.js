import { Metric } from "effect";
import { contextWindowBuckets } from "./_buckets.js";
export const tokensContextWindowPerCall = Metric.histogram("smithers.tokens.context_window_per_call", contextWindowBuckets);
