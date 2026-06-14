/**
 * The connection lifecycle of the gateway link, derived from real transport
 * traffic (RPC resolves, stream frames, auth/transport errors). Mirrors the
 * union apps/smithers used to keep in its hand-rolled `GatewayStatus` store
 * field, now surfaced by `useGatewayConnectionStatus`.
 */
export type GatewayConnectionStatus =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "unauthorized";

export type GatewayConnectionState = {
  status: GatewayConnectionStatus;
  /** Epoch ms of the first failure in the current offline streak; cleared on reconnect. */
  reconnectingSince?: number;
};
