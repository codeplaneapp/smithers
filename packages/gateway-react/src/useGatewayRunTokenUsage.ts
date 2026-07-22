import { useEffect, useRef } from "react";
import type { ListRunTokenUsageResponse } from "@smithers-orchestrator/gateway-client";
import type { GatewayAsyncState } from "./GatewayAsyncState.ts";
import { useGatewayRpc } from "./useGatewayRpc.ts";

/** Complete persisted token usage for a run. Set refreshMs while the run is live. */
export function useGatewayRunTokenUsage(
  runId: string,
  options: { refreshMs?: number } = {},
): GatewayAsyncState<ListRunTokenUsageResponse> {
  const state = useGatewayRpc("listRunTokenUsage", { runId }, { enabled: runId.length > 0 });
  const refreshMs = options.refreshMs;
  const refetch = state.refetch;

  const wasPollingRef = useRef(false);

  useEffect(() => {
    if (refreshMs === undefined || !Number.isFinite(refreshMs) || refreshMs <= 0 || runId.length === 0) {
      // Polling just stopped (live → settled): the final attempt's usage lands
      // seconds before settle, so fire one last fetch instead of dropping it.
      if (wasPollingRef.current && runId.length > 0) void refetch();
      wasPollingRef.current = false;
      return;
    }
    wasPollingRef.current = true;
    const timer = setInterval(() => {
      void refetch();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs, refetch, runId]);

  return state;
}
