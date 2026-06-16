import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { gatewayKeys, type GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
import type { ListApprovalsRequest, ListApprovalsResponse } from "@smithers-orchestrator/gateway/rpc";
import { useGatewayCollectionStatus } from "./sync/useGatewayCollectionStatus.ts";
import { useSyncClient } from "./sync/useSyncClient.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live pending-approval list over the `approvals` collection (initial
 * `listApprovals`, re-pulled on `invalidate` — e.g. after a run reaches
 * waiting-approval or a `submitApproval` mutation). Same `GatewayAsyncState`
 * shape the RPC hook returned.
 */
export function useGatewayApprovals(params: ListApprovalsRequest = {}): GatewayAsyncState<ListApprovalsResponse> {
  const registry = useSyncClient();
  const key = gatewayKeys.approvals(params);
  const status = useGatewayCollectionStatus(key);
  const collection = registry.approvals(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await registry.invalidate(key);
  }, [registry, key]);

  const data = (live.data ?? []) as GatewayApprovalRow[] as ListApprovalsResponse;
  return {
    data,
    error: status.status === "error" ? status.error : undefined,
    loading: status.status === "loading" && data.length === 0,
    refetch,
  };
}
