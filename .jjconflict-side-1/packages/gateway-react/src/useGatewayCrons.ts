import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayCronRow } from "@smithers-orchestrator/gateway-client";
import type { CronListRequest } from "@smithers-orchestrator/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live cron-schedule list over the `crons` collection (initial `cronList`,
 * re-pulled on `invalidate` — e.g. after a `cronCreate` / `cronDelete` / `cronRun`
 * mutation). `cronList` returns ALL crons (enabled + disabled), so disabled rows
 * surface too. Same `GatewayAsyncState` shape the other typed gateway hooks
 * return (mirrors `useGatewayApprovals`).
 */
export function useGatewayCrons(params: CronListRequest = {}): GatewayAsyncState<GatewayCronRow[]> {
  const { collections } = useSmithersCollections();
  const collection = collections.crons(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["crons"]);
  }, [collections, params]);

  const data = (live.data ?? []) as GatewayCronRow[];
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}
