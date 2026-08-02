import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayRpcPayload, GatewayRunRow } from "@smthrs/gateway-client";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live single-run record over the `run` collection (initial `getRun` +
 * `streamRunEvents`, so each lifecycle frame upserts the row without a
 * whole-tree refetch). Same `GatewayAsyncState` shape the RPC hook returned.
 */
export function useGatewayRun(runId: string | undefined): GatewayAsyncState<GatewayRpcPayload<"getRun">> {
  const { collections } = useSmithersCollections();
  const collection = runId ? collections.run(runId) : undefined;
  const live = useLiveQuery((q) => (collection ? q.from({ row: collection }) : undefined), [collection]);
  const refetch = useCallback(async () => {
    if (runId) await collections.invalidate(["runs"]);
  }, [collections, runId]);

  const data = ((live.data ?? []) as GatewayRunRow[]).find((row) => row.runId === runId) as
    | GatewayRpcPayload<"getRun">
    | undefined;
  return gatewayCollectionAsyncState({
    collection: collection ?? {},
    data,
    hasData: !runId || data !== undefined,
    live,
    refetch,
  });
}
