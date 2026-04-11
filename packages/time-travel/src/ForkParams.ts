/**
 * Parameters for forking a run.
 */
export type ForkParams = {
  parentRunId: string;
  frameNo: number;
  inputOverrides?: Record<string, unknown>;
  resetNodes?: string[];
  branchLabel?: string;
  forkDescription?: string;
};
