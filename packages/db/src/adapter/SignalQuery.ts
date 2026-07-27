export type SignalQuery = {
  signalName?: string;
  correlationId?: string | null;
  afterSeq?: number;
  receivedAfterMs?: number;
  limit?: number;
};
