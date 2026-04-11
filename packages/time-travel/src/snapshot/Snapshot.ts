/**
 * Serialized snapshot of workflow state at a specific frame.
 */
export type Snapshot = {
  runId: string;
  frameNo: number;
  nodesJson: string;
  outputsJson: string;
  ralphJson: string;
  inputJson: string;
  vcsPointer: string | null;
  workflowHash: string | null;
  contentHash: string;
  createdAtMs: number;
};
