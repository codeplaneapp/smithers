import type { GatewayApprovalSummary } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayApprovalRow = GatewayApprovalSummary & GatewayVirtualRow & {
  status?: "requested" | "approved" | "denied";
  decision?: unknown;
  decidedAtMs?: number;
};
