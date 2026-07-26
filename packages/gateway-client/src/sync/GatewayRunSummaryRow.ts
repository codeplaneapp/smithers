export type GatewayRunSummaryRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  system: boolean;
  startedBy?: import("@smithers-orchestrator/protocol/gateway-rpc").RunStartedBy;
};
