export type MemoryThread = {
  threadId: string;
  namespace: string;
  title?: string | null;
  metadataJson?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};
