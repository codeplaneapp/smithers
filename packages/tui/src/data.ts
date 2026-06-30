import {
  useGatewayRun,
  useGatewayApprovals,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayNodeOutput,
  useGatewayActions,
  useGatewayRpc,
} from "@smithers-orchestrator/gateway-react";
import type { GatewayAsyncState } from "@smithers-orchestrator/gateway-react";
import type { UseGatewayRunTreeResult } from "@smithers-orchestrator/gateway-react";
import type { GatewayRpcPayload, GatewayRunNode, GatewayApprovalRow, GatewayEventFrame } from "@smithers-orchestrator/gateway-client";

export type RunData = GatewayAsyncState<GatewayRpcPayload<"getRun">>;

export function useRun(runId: string): RunData {
  return useGatewayRun(runId);
}

export function useRunTree(runId: string): UseGatewayRunTreeResult {
  return useGatewayRunTree(runId);
}

export function useApprovals(runId: string): GatewayAsyncState<GatewayApprovalRow[]> {
  return useGatewayApprovals({ filter: { runId } }) as GatewayAsyncState<GatewayApprovalRow[]>;
}

export function useRunEvents(runId: string, options?: { afterSeq?: number; maxEvents?: number }): {
  events: GatewayEventFrame[];
  lastHeartbeat: GatewayEventFrame | undefined;
  error: Error | undefined;
  streaming: boolean;
} {
  return useGatewayRunEvents(runId, options);
}

export function useNodeOutput(params: {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
}) {
  return useGatewayNodeOutput(params);
}

export function useActions() {
  return useGatewayActions();
}

/**
 * Fetch the node-level diff bundle for one node iteration via the gateway's
 * `getNodeDiff` RPC. Disabled (no request issued) until both runId and nodeId
 * are known so switching focus to a node with no identity doesn't fire a bad
 * request. Returns the standard async state; the payload is a `DiffBundle` or a
 * stat-only summary (see `toNodeDiffView`).
 */
export function useNodeDiff(params: {
  runId: string | undefined;
  nodeId: string | undefined;
  iteration?: number;
}): GatewayAsyncState<GatewayRpcPayload<"getNodeDiff">> {
  const enabled = Boolean(params.runId && params.nodeId);
  return useGatewayRpc(
    "getNodeDiff",
    { runId: params.runId ?? "", nodeId: params.nodeId ?? "", iteration: params.iteration },
    { enabled },
  );
}

export type { GatewayAsyncState, GatewayRpcPayload, GatewayRunNode, GatewayApprovalRow, GatewayEventFrame, UseGatewayRunTreeResult };
