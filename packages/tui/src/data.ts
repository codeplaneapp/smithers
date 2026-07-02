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

/**
 * Single source of truth for how much run-event history the TUI retains.
 *
 * The gateway caches one `runEvents` collection per `(runId, maxRows)` (the cap
 * is part of the collection key), so
 * consumers asking for different caps get separate rings and separate streams.
 * Every TUI event consumer therefore requests THIS one cap, so they all share a
 * single correctly-sized ring (and one stream) regardless of mount order —
 * rather than fragmenting into per-cap collections.
 */
export const TUI_EVENT_CAP = 2000;

/** Resolve a consumer's requested cap, defaulting to the shared {@link TUI_EVENT_CAP}. */
export function tuiEventCap(maxEvents?: number): number {
  return maxEvents ?? TUI_EVENT_CAP;
}

export function useRunEvents(runId: string, options?: { afterSeq?: number; maxEvents?: number }): {
  events: GatewayEventFrame[];
  lastHeartbeat: GatewayEventFrame | undefined;
  error: Error | undefined;
  streaming: boolean;
} {
  // Default every consumer to the shared cap so the per-run ring is sized for
  // the largest window any mode needs, no matter the mount order.
  return useGatewayRunEvents(runId, { ...options, maxEvents: tuiEventCap(options?.maxEvents) });
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
