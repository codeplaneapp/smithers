import { useLiveQuery } from "@tanstack/react-db";
import { useCallback } from "react";
import type { ListDocsRequest } from "@smithers-orchestrator/gateway/rpc";
import { gatewayKeys } from "@smithers-orchestrator/gateway-client";
import type { GatewayDocRow } from "@smithers-orchestrator/gateway-client";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";
import { useSyncClient } from "./sync/useSyncClient.ts";
import { useGatewayCollectionStatus } from "./sync/useGatewayCollectionStatus.ts";

export function useGatewayTickets(params: ListDocsRequest = {}): GatewayAsyncState<GatewayDocRow[]> {
  const registry = useSyncClient();
  const includeDeleted = params.filter?.includeDeleted === true;
  const effectiveParams = {
    ...params,
    filter: {
      ...params.filter,
      includeDeleted: params.filter?.includeDeleted ?? true,
    },
  };
  const key = gatewayKeys.tickets(effectiveParams);
  const status = useGatewayCollectionStatus(key);
  const collection = registry.tickets(effectiveParams);
  const live = useLiveQuery((q) => q.from({ row: collection }), [collection]);
  const refetch = useCallback(async () => {
    await registry.invalidate(key);
  }, [registry, key]);
  const data = ((live.data ?? []) as GatewayDocRow[])
    .filter((row) => includeDeleted || row.deletedAtMs == null)
    .slice()
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    data,
    error: status.status === "error" ? status.error : undefined,
    loading: status.status === "loading" && data.length === 0,
    refetch,
  };
}
