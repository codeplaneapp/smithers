import { useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { gatewayKeys, type GatewayRpcPayload, type GatewayRunRow } from "@smithers-orchestrator/gateway-client";
import { useGatewayCollectionStatus } from "./sync/useGatewayCollectionStatus.ts";
import { useSyncClient } from "./sync/useSyncClient.ts";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";

/**
 * Live single-run record over the `run` collection (initial `getRun` +
 * `streamRunEvents`, so each lifecycle frame upserts the row without a
 * whole-tree refetch). Same `GatewayAsyncState` shape the RPC hook returned.
 */
export function useGatewayRun(runId: string | undefined): GatewayAsyncState<GatewayRpcPayload<"getRun">> {
  const registry = useSyncClient();
  const key = runId ? gatewayKeys.run(runId) : undefined;
  const status = useGatewayCollectionStatus(key ?? ["gateway:run", "disabled"]);
  const collection = runId ? registry.run(runId) : undefined;
  const live = useLiveQuery(
    (q) => (collection ? q.from({ row: collection }) : undefined),
    [collection],
  );
  const refetch = useCallback(async () => {
    if (key) await registry.invalidate(key);
  }, [registry, key]);

  const data = ((live.data ?? []) as GatewayRunRow[])[0] as GatewayRpcPayload<"getRun"> | undefined;
  return {
    data,
    error: status.status === "error" ? status.error : undefined,
    loading: Boolean(runId) && status.status === "loading" && data === undefined,
    refetch,
  };
}
