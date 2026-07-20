export type GatewayRunEventRow = {
  runId: string;
  seq: number;
  event: string;
  payload: unknown;
  timestampMs?: number;
};
