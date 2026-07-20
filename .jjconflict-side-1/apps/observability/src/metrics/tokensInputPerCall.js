import { Metric } from "effect";
import { tokenBuckets } from "./_buckets.js";
export const tokensInputPerCall = Metric.histogram("smithers.tokens.input_per_call", tokenBuckets);
