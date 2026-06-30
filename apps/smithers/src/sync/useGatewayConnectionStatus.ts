import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useSyncClient } from "@smithers-orchestrator/gateway-react";
import {
  connectionStateValue,
  gatewayConnectionState,
} from "../observability/uiMetrics";
import type { GatewayStatus } from "../gateway/gatewayTypes";

type GatewayConnectionStatus = {
  status: GatewayStatus;
  isOnline: boolean;
  reconnectingSince?: number;
};

/**
 * Connection status derived from the registry's connection observer, which the
 * instrumented transport drives off real traffic (RPC resolves, stream frames,
 * auth/transport errors). This replaces an earlier `useGatewayWorkflows` probe
 * that could never surface an error (collection-backed hooks return
 * `error: undefined`), so offline/unauthorized links were reported as `online`.
 */
export function useGatewayConnectionStatus(): GatewayConnectionStatus {
  const registry = useSyncClient();
  const state = useSyncExternalStore(
    registry.subscribeConnection,
    registry.connection,
    registry.connection,
  );

  // Probe once on mount so an otherwise idle link leaves `idle`; the observer
  // flips to online/offline/unauthorized off the result.
  useEffect(() => {
    void registry.connect();
  }, [registry]);

  const status = state.status as GatewayStatus;

  useEffect(() => {
    gatewayConnectionState.set(connectionStateValue(status));
  }, [status]);

  return useMemo(
    () => ({
      status,
      isOnline: status === "online",
      ...(state.reconnectingSince === undefined
        ? {}
        : { reconnectingSince: state.reconnectingSince }),
    }),
    [status, state.reconnectingSince],
  );
}
