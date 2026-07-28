export type AgentCheckpointContentRow = {
  contentHash: string;
  checkpointJson: string;
  sizeBytes: number;
  createdAtMs: number;
};

export type AgentCheckpointRefRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  sequence: number;
  contentHash: string;
  codec: string;
  version: number;
  agentId: string | null;
  purpose: string;
  createdAtMs: number;
};
