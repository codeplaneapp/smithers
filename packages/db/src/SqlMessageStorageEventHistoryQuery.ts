export type SqlMessageStorageEventHistoryQuery = {
  afterSeq?: number;
  limit?: number;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  types?: readonly string[];
  sinceTimestampMs?: number;
};
