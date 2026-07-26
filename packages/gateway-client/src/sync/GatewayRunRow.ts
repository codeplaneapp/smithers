export type GatewayRunRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  system: boolean;
  startedAtMs?: number;
  finishedAtMs?: number;
  summary?: unknown;
  runState?: unknown;
  startedBy?: import("@smithers-orchestrator/protocol/gateway-rpc").RunStartedBy;
};
