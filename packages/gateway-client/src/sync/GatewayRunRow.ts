import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayRunRow = Record<string, unknown> & GatewayVirtualRow & {
  runId: string;
  workflowKey?: string;
  status?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  summary?: unknown;
  runState?: unknown;
};
