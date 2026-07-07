export type MemoryMessage = {
  id: string;
  threadId: string;
  role: string;
  contentJson: string;
  runId?: string | null;
  nodeId?: string | null;
  /** Provenance: completes the run coordinate alongside runId/nodeId. */
  iteration?: number | null;
  createdAtMs: number;
};
