import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { gatewayKeys, type GatewayRunSummaryRow } from "@smithers-orchestrator/gateway-client";
import type { ListRunsRequest } from "@smithers-orchestrator/gateway/rpc";
import { useGatewayCollectionStatus } from "./sync/useGatewayCollectionStatus.ts";
import { useSyncClient } from "./sync/useSyncClient.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live run list over the `runs` collection (initial `listRuns`, re-pulled on
 * `invalidate`). Same `GatewayAsyncState` shape the RPC hook returned.
 */
export function useGatewayRuns(params: ListRunsRequest = {}): GatewayAsyncState<GatewayRunSummaryRow[]> {
  const registry = useSyncClient();
  const key = gatewayKeys.runs(params);
  const status = useGatewayCollectionStatus(key);
  const collection = registry.runs(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await registry.invalidate(key);
  }, [registry, key]);

  const data = (live.data ?? []) as GatewayRunSummaryRow[];
  return {
    data,
    error: status.status === "error" ? status.error : undefined,
    loading: status.status === "loading" && data.length === 0,
    refetch,
  };
}
