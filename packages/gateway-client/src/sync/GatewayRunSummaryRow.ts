export type GatewayRunSummaryRow = Record<string, unknown> & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  summary?: Record<string, number>;
};
