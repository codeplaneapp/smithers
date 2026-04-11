export type MemoryMessage = {
  id: string;
  threadId: string;
  role: string;
  contentJson: string;
  runId?: string | null;
  nodeId?: string | null;
  createdAtMs: number;
};
