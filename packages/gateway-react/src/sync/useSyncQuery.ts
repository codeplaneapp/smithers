import { useCallback, useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { syncKeyFingerprint, type SyncKey } from "@smithers-orchestrator/gateway-client";
import { useSyncClient } from "./useSyncClient.ts";
import type { GatewayQueryRow } from "./GatewayCollections.ts";

/**
 * Declarative data fetching for the sync registry. Backed by TanStack DB's
 * `useLiveQuery` over a single-value query collection: the collection's sync
 * runs the `fetcher`, and status / data / error ride in the stored row so a
 * single live subscription carries every transition.
 *
 * Behavior:
 *  - On mount `useLiveQuery` subscribes (starting the collection's sync) and the
 *    fetcher runs once.
 *  - Concurrent components with the same key share ONE collection (and one
 *    in-flight fetch) — multiplexing falls out of the per-key collection id.
 *  - `refetch()` forces a fresh fetch.
 *  - Unmount drops the subscription; the collection GCs after its `gcTime`.
 */

export type UseSyncQueryResult<T> = {
  data: T | undefined;
  error: Error | undefined;
  status: "idle" | "loading" | "success" | "error";
  /** True when no data yet and a fetch is in flight. */
  isLoading: boolean;
  /** True when data exists and a refetch is in flight. */
  isRefreshing: boolean;
  refetch: () => Promise<T | undefined>;
};

export type UseSyncQueryOptions = {
  /** Disable the query (skip subscribe + fetch). Used for conditional loads. */
  enabled?: boolean;
  /**
   * Treat cached data as fresh for this long. The registry memoizes a query
   * collection per key across mounts, so data within `gcTime` is reused without
   * a refetch; kept for API compatibility.
   */
  staleTimeMs?: number;
};

export function useSyncQuery<T>(
  key: SyncKey,
  fetcher: () => Promise<T>,
  options: UseSyncQueryOptions = {},
): UseSyncQueryResult<T> {
  const registry = useSyncClient();
  const enabled = options.enabled ?? true;
  const fingerprint = useMemo(() => syncKeyFingerprint(key), [key]);
  // Resolve (or create) the per-key collection; the registry pins the latest
  // fetcher closure so refetch/invalidate use current params.
  const handle = enabled ? registry.query<T>(key, fetcher) : undefined;

  const live = useLiveQuery(
    (q) => (handle ? q.from({ row: handle.collection }) : undefined),
    [fingerprint, enabled],
  );

  const refetch = useCallback(
    () => (handle ? handle.refetch() : Promise.resolve(undefined)),
    [handle],
  );

  if (!enabled) {
    return {
      data: undefined,
      error: undefined,
      status: "idle",
      isLoading: false,
      isRefreshing: false,
      refetch,
    };
  }

  const row = ((live.data ?? []) as GatewayQueryRow<T>[])[0];
  const status = row && row.status !== "idle" ? row.status : "loading";
  const data = row?.value;
  return {
    data,
    error: status === "error" ? row?.error : undefined,
    status,
    isLoading: status === "loading" && data === undefined,
    isRefreshing: status === "loading" && data !== undefined,
    refetch,
  };
}
