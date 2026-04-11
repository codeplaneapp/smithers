export type MemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
  schemaSig?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  ttlMs?: number | null;
};
