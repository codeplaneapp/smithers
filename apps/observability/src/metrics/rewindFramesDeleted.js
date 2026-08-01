import { Metric } from "effect";
const buckets = Metric.exponentialBoundaries({ start: 1, factor: 2, count: 18 });
export const rewindFramesDeleted = Metric.histogram("smithers_rewind_frames_deleted", { boundaries: buckets });
