import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useSmithersCollections } from "@smithers-orchestrator/gateway-react";
import { connectionStateValue, gatewayConnectionState } from "../observability/uiMetrics";
import type { GatewayStatus } from "../gateway/gatewayTypes";

type GatewayConnectionStatus = {
  status: GatewayStatus;
  isOnline: boolean;
  reconnectingSince?: number;
};

/**
 * Connection status derived from the data client's SSE stream observer, which
 * is driven by real gateway traffic and auth/transport errors.
 */
export function useGatewayConnectionStatus(): GatewayConnectionStatus {
  const { client } = useSmithersCollections();
  const state = useSyncExternalStore(client.stream.subscribeStatus, client.stream.status, client.stream.status);

  useEffect(() => {
    return client.stream.subscribe(() => {});
  }, [client]);

  const status = state.status as GatewayStatus;

  useEffect(() => {
    gatewayConnectionState.set(connectionStateValue(status));
  }, [status]);

  return useMemo(
    () => ({
      status,
      isOnline: status === "online",
      ...(state.reconnectingSince === undefined ? {} : { reconnectingSince: state.reconnectingSince }),
    }),
    [status, state.reconnectingSince],
  );
}
