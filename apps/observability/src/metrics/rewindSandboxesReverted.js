import { Metric } from "effect";
const buckets = Metric.boundariesFromIterable([0, 1, 2, 4, 8, 16, 32, 64]);
export const rewindSandboxesReverted = Metric.histogram("smithers_rewind_sandboxes_reverted", { boundaries: buckets });
