/**
 * Parameters for replaying from a checkpoint.
 */
export type ReplayParams = {
  parentRunId: string;
  frameNo: number;
  inputOverrides?: Record<string, unknown>;
  /**
   * Node IDs to reset to `pending` in the child. Only these nodes reset — a
   * fork never expands to downstream dependents, so a node that consumed a
   * reset node's output keeps the parent's finished output unless it is named
   * here too. Each entry is a node ID (resets every iteration of that node) or
   * a fully-qualified `nodeId::iteration` key.
   */
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
