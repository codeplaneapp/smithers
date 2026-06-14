export type GatewayRunRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  summary?: unknown;
  runState?: unknown;
};
