/**
 * Parameters for replaying from a checkpoint.
 */
export type ReplayParams = {
  parentRunId: string;
  frameNo: number;
  inputOverrides?: Record<string, unknown>;
  resetNodes?: string[];
  branchLabel?: string;
  restoreVcs?: boolean;
  cwd?: string;
};
