import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { GatewayPromptRow } from "@smithers-orchestrator/gateway-client";
import type { ListPromptsRequest } from "@smithers-orchestrator/gateway-client/rpc";
import { useSmithersCollections } from "./useSmithersCollections.ts";
import { gatewayCollectionAsyncState, type GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live registered-prompt list over the `prompts` collection (initial
 * `listPrompts`, re-pulled on `invalidate`). The gateway enumerates the
 * `.smithers/prompts/**.{md,mdx}` files on disk, so the rows are read-only on the
 * wire (no write RPC) and this hook is query-only — the same `GatewayAsyncState`
 * shape the other typed gateway hooks return (mirrors `useGatewayMemoryFacts`).
 */
export function useGatewayPrompts(): GatewayAsyncState<GatewayPromptRow[]> {
  const params: ListPromptsRequest = {};
  const { collections } = useSmithersCollections();
  const collection = collections.prompts();
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await collections.invalidate(["prompts"]);
  }, [collections]);

  const data = (live.data ?? []) as GatewayPromptRow[];
  return gatewayCollectionAsyncState({
    collection,
    data,
    hasData: data.length > 0,
    live,
    refetch,
  });
}
