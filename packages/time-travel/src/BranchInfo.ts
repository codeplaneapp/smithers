/**
 * Branch metadata.
 */
export type BranchInfo = {
  runId: string;
  parentRunId: string;
  parentFrameNo: number;
  branchLabel: string | null;
  forkDescription: string | null;
  createdAtMs: number;
};
