import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayMemoryFactRow } from "@smithers-orchestrator/gateway-client";
import type { ListMemoryFactsRequest } from "@smithers-orchestrator/gateway/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live cross-run memory facts over the `memoryFacts` collection (initial
 * `listMemoryFacts`, re-pulled on `invalidate`). Pass a `namespace` to scope the
 * list to one namespace; omit it to list every namespace's facts. The facts are
 * read-only on the wire (no write RPC), so this hook is query-only — the same
 * `GatewayAsyncState` shape the other typed gateway hooks return (mirrors
 * `useGatewayCrons`).
 */
export function useGatewayMemoryFacts(namespace?: string): GatewayAsyncState<GatewayMemoryFactRow[]> {
  const params: ListMemoryFactsRequest = namespace ? { namespace } : {};
  const { collections } = useSmithersCollections();
  const collection = collections.memoryFacts(params);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["memoryFacts"]);
  }, [collections, namespace]);

  const data = (live.data ?? []) as GatewayMemoryFactRow[];
  return {
    data,
    error: undefined,
    loading: !live.isReady && data.length === 0,
    refetch,
  };
}
