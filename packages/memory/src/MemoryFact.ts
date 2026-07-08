export type MemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
  schemaSig?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  ttlMs?: number | null;
  /** Provenance: the run coordinate of the LAST write (facts are upserts). */
  runId?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
};
