import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayWorkflowRow } from "@smthrs/gateway-client";
import type { ListWorkflowsRequest, ListWorkflowsResponse } from "@smthrs/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live workflow list over the `workflows` collection (initial `listWorkflows`,
 * re-pulled on `invalidate`). Same `GatewayAsyncState` shape the RPC hook
 * returned.
 */
export function useGatewayWorkflows(params: ListWorkflowsRequest = {}): GatewayAsyncState<ListWorkflowsResponse> {
  const { collections } = useSmithersCollections();
  const collection = collections.workflows(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["workflows"]);
  }, [collections]);

  const data = (live.data ?? []) as GatewayWorkflowRow[] as ListWorkflowsResponse;
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}
