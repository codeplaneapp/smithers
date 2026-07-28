import type { BranchInfo } from "./BranchInfo";
import type { TimelineFrame } from "./TimelineFrame";

/**
 * Timeline for a single run.
 */
export type RunTimeline = {
  runId: string;
  frames: TimelineFrame[];
  branch: BranchInfo | null;
  /** Durable operator controls that affect oneshot execution between frames. */
  controls?: Array<{
    seq: number;
    type: string;
    timestampMs: number;
    payload: Record<string, unknown>;
  }>;
};
