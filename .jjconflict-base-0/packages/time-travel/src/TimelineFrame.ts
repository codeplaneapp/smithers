import type { BranchInfo } from "./BranchInfo";

/**
 * Timeline entry for a single frame in a run.
 */
export type TimelineFrame = {
  frameNo: number;
  createdAtMs: number;
  contentHash: string;
  forkPoints: BranchInfo[];
};
