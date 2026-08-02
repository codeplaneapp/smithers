export type GatewayRunRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  parentRunId?: string | null;
  system: boolean;
  startedAtMs?: number;
  finishedAtMs?: number;
  summary?: unknown;
  runState?: unknown;
  startedBy?: import("@smthrs/protocol/gateway-rpc").RunStartedBy;
};
