import { useEffect } from "react";
import type { UsageReport } from "@smithers-orchestrator/gateway-client";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";
import { useGatewayRpc } from "./useGatewayRpc.ts";

const DEFAULT_REFRESH_MS = 60_000;

/** Provider rate-limit and subscription usage, refreshed once per cache TTL. */
export function useGatewayUsageReports(
  options: { refreshMs?: number } = {},
): GatewayAsyncState<UsageReport[]> {
  const state = useGatewayRpc("listUsageReports", {});
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const refetch = state.refetch;

  useEffect(() => {
    if (!Number.isFinite(refreshMs) || refreshMs <= 0) return;
    const timer = setInterval(() => {
      void refetch();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, refetch]);

  return state;
}
