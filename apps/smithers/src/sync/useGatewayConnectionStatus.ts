import { useEffect, useMemo, useRef } from "react";
import { useGatewayWorkflows } from "@smithers-orchestrator/gateway-react";
import {
  connectionStateValue,
  gatewayConnectionState,
} from "../observability/uiMetrics";
import { isAuthError } from "../gateway/gatewayClient";
import type { GatewayStatus } from "../gateway/gatewayTypes";

type GatewayConnectionStatus = {
  status: GatewayStatus;
  isOnline: boolean;
  reconnectingSince?: number;
};

export function useGatewayConnectionStatus(): GatewayConnectionStatus {
  const probe = useGatewayWorkflows({ filter: { hasUi: true } });
  const status: GatewayStatus = probe.loading
    ? "connecting"
    : probe.error
      ? isAuthError(probe.error) ? "unauthorized" : "offline"
      : probe.data
        ? "online"
        : "idle";
  const reconnectingSinceRef = useRef<number | undefined>(undefined);

  if (status === "connecting" || status === "offline") {
    reconnectingSinceRef.current ??= Date.now();
  } else {
    reconnectingSinceRef.current = undefined;
  }

  useEffect(() => {
    gatewayConnectionState.set(connectionStateValue(status));
  }, [status]);

  return useMemo(
    () => ({
      status,
      isOnline: status === "online",
      ...(reconnectingSinceRef.current === undefined
        ? {}
        : { reconnectingSince: reconnectingSinceRef.current }),
    }),
    [status],
  );
}
