import { useSyncExternalStore } from "react";
import { useSyncClient } from "./useSyncClient.ts";
import type { GatewayConnectionStatus } from "./GatewayConnectionState.ts";

export type UseGatewayConnectionStatusResult = {
  status: GatewayConnectionStatus;
  isOnline: boolean;
  /** Epoch ms of the first failure in the current offline streak, when offline. */
  reconnectingSince?: number;
};

/**
 * The gateway link's connection lifecycle, derived from real transport traffic
 * by the registry (RPC resolves / stream frames mark it online; transport
 * errors mark it offline; auth failures mark it unauthorized). Replaces the
 * hand-rolled `GatewayStatus` field apps/smithers kept in its zustand store.
 */
export function useGatewayConnectionStatus(): UseGatewayConnectionStatusResult {
  const registry = useSyncClient();
  const state = useSyncExternalStore(
    registry.subscribeConnection,
    registry.connection,
    registry.connection,
  );
  return {
    status: state.status,
    isOnline: state.status === "online",
    ...(state.reconnectingSince !== undefined ? { reconnectingSince: state.reconnectingSince } : {}),
  };
}
