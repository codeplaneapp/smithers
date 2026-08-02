import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayScoreRow } from "@smthrs/gateway-client";
import type { ListScoresRequest } from "@smthrs/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live scorer/eval results for one run over the `scores` collection (initial
 * `listScores`, re-pulled on `invalidate`). Pass a `runId` to list every score
 * the run recorded; pass `nodeId` too to scope to one node. Scores are read-only
 * on the wire (no write RPC), so this hook is query-only — the same
 * `GatewayAsyncState` shape the other typed gateway hooks return (mirrors
 * `useGatewayMemoryFacts`).
 *
 * An empty `runId` resolves to a stable, empty collection (no run selected yet),
 * so consumers can call the hook unconditionally and render the empty state.
 */
export function useGatewayScores(runId: string, nodeId?: string): GatewayAsyncState<GatewayScoreRow[]> {
  const params: ListScoresRequest = nodeId ? { runId, nodeId } : { runId };
  const { collections } = useSmithersCollections();
  const collection = collections.scores(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["scores"]);
  }, [collections, runId, nodeId]);

  const data = (live.data ?? []) as GatewayScoreRow[];
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}
