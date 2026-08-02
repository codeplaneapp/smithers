import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayApprovalRow } from "@smthrs/gateway-client";
import type { ListApprovalsRequest, ListApprovalsResponse } from "@smthrs/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live pending-approval list over the `approvals` collection (initial
 * `listApprovals`, re-pulled on `invalidate` — e.g. after a run reaches
 * waiting-approval or a `submitApproval` mutation). Same `GatewayAsyncState`
 * shape the RPC hook returned.
 */
export function useGatewayApprovals(params: ListApprovalsRequest = {}): GatewayAsyncState<ListApprovalsResponse> {
  const { collections } = useSmithersCollections();
  const collection = collections.approvals(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["approvals"]);
  }, [collections]);

  const data = (live.data ?? []) as GatewayApprovalRow[] as ListApprovalsResponse;
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}
