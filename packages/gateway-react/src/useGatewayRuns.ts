import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { gatewayKeys, type GatewayRpcPayload, type GatewayRunSummaryRow } from "@smithers-orchestrator/gateway-client";
import type { ListRunsRequest } from "@smithers-orchestrator/gateway/rpc";
import { useSyncClient } from "./sync/useSyncClient.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live run list over the `runs` collection (initial `listRuns`, re-pulled on
 * `invalidate`). Same `GatewayAsyncState` shape the RPC hook returned.
 */
export function useGatewayRuns(params: ListRunsRequest = {}): GatewayAsyncState<GatewayRpcPayload<"listRuns">> {
  const registry = useSyncClient();
  const collection = registry.runs(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await registry.invalidate(gatewayKeys.runs(params));
  }, [registry, collection]);

  const data = (live.data ?? []) as GatewayRunSummaryRow[] as GatewayRpcPayload<"listRuns">;
  return {
    data,
    error: undefined,
    loading: !live.isReady && data.length === 0,
    refetch,
  };
}
