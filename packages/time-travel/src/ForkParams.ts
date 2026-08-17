/**
 * Parameters for forking a run.
 */
export type ForkParams = {
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
  forkDescription?: string;
  workflowPath?: string | null;
  workflowHash?: string | null;
  entryWorkflowHash?: string | null;
  force?: boolean;
  /** True when the caller will immediately resume the child. */
  autoRun?: boolean;
  /** Internal operation label used by replay. */
  operation?: "fork" | "replay";
};
