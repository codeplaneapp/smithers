export type GatewayRunSummaryRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  parentRunId?: string | null;
  system: boolean;
  startedBy?: import("@smthrs/protocol/gateway-rpc").RunStartedBy;
};
