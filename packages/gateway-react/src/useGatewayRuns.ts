import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayRpcPayload, GatewayRunSummaryRow } from "@smithers-orchestrator/gateway-client";
import type { ListRunsRequest } from "@smithers-orchestrator/gateway/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live run list over the `runs` collection (initial `listRuns`, re-pulled on
 * `invalidate`). Same `GatewayAsyncState` shape the RPC hook returned.
 */
export function useGatewayRuns(params: ListRunsRequest = {}): GatewayAsyncState<GatewayRpcPayload<"listRuns">> {
  const { collections } = useSmithersCollections();
  const collection = collections.runs(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["runs"]);
  }, [collections, params]);

  const data = (live.data ?? []) as GatewayRunSummaryRow[] as GatewayRpcPayload<"listRuns">;
  return {
    data,
    error: undefined,
    loading: !live.isReady && data.length === 0,
    refetch,
  };
}
