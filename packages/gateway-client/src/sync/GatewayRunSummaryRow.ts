import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayRunSummaryRow = Record<string, unknown> & GatewayVirtualRow & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
};
