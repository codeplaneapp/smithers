import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { gatewayKeys, type GatewayWorkflowRow } from "@smithers-orchestrator/gateway-client";
import type { ListWorkflowsRequest } from "@smithers-orchestrator/gateway/rpc";
import { useGatewayCollectionStatus } from "./sync/useGatewayCollectionStatus.ts";
import { useSyncClient } from "./sync/useSyncClient.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live workflow list over the `workflows` collection (initial `listWorkflows`,
 * re-pulled on `invalidate`). Same `GatewayAsyncState` shape the RPC hook
 * returned.
 */
export function useGatewayWorkflows(params: ListWorkflowsRequest = {}): GatewayAsyncState<GatewayWorkflowRow[]> {
  const registry = useSyncClient();
  const key = gatewayKeys.workflows(params.filter);
  const status = useGatewayCollectionStatus(key);
  const collection = registry.workflows(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await registry.invalidate(key);
  }, [registry, key]);

  const data = (live.data ?? []) as GatewayWorkflowRow[];
  return {
    data,
    error: status.status === "error" ? status.error : undefined,
    loading: status.status === "loading" && data.length === 0,
    refetch,
  };
}
