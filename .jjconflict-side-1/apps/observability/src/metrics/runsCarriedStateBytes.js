import { Metric } from "effect";
import { carriedStateSizeBuckets } from "./_buckets.js";
export const runsCarriedStateBytes = Metric.histogram("smithers.runs.carried_state_bytes", carriedStateSizeBuckets);
