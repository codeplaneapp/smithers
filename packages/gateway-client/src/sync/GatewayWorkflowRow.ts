import type { GatewayWorkflowSummary } from "@smithers-orchestrator/gateway/rpc";
import type { GatewayVirtualRow } from "./GatewayVirtualRow.ts";

export type GatewayWorkflowRow = GatewayWorkflowSummary & GatewayVirtualRow;
