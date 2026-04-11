import type { BranchInfo } from "./BranchInfo";
import type { TimelineFrame } from "./TimelineFrame";

/**
 * Timeline for a single run.
 */
export type RunTimeline = {
  runId: string;
  frames: TimelineFrame[];
  branch: BranchInfo | null;
};
