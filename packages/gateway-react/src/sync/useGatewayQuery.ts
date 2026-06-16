import { useMemo } from "react";
import { syncKeyFingerprint, type SyncKey } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";
import { useSyncQuery, type UseSyncQueryOptions, type UseSyncQueryResult } from "./useSyncQuery.ts";

/**
 * A typed convenience over `useSyncQuery` for ad-hoc gateway RPCs. Picks the
 * cache key from `gatewayKeys` (or any `SyncKey`), wires the fetcher to
 * `registry.rpc`, and gives consumers the same
 * `{data, error, status, refetch, isLoading}` shape they get from
 * `useGatewayRpc`.
 */
export function useGatewayQuery<T = unknown>(
  key: SyncKey,
  method: string,
  params: Record<string, unknown>,
  options: UseSyncQueryOptions = {},
): UseSyncQueryResult<T> {
  const registry = useSyncClient();
  // Memoize the fetcher / key on the serialized params so identical calls don't
  // churn the resolved collection.
  const paramsKey = syncKeyFingerprint(["params", params ?? {}]);
  const queryKey = useMemo(() => [...key, { params: params ?? {} }] as SyncKey, [key, paramsKey]);
  const fetcher = useMemo(
    () => () => registry.rpc<T>(method, params ?? {}),
    [registry, method, paramsKey],
  );
  return useSyncQuery<T>(queryKey, fetcher, options);
}
