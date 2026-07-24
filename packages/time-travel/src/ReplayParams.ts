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
  /**
   * Re-bless the forked run's durable workflow metadata to the workflow being
   * replayed. Without these, the fork inherits the PARENT's hashes and the
   * resume guard (assertResumeDurabilityMetadata) rejects a replay whose
   * workflow source was edited — defeating the "carry the edit forward" purpose
   * of replay. The CLI computes these from the resolved workflow file (mirrors
   * the `fork` command); omit them to keep the parent's metadata unchanged.
   */
  workflowPath?: string;
  workflowHash?: string | null;
  entryWorkflowHash?: string | null;
  force?: boolean;
};
