export type GatewayConnectionStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";

export type GatewayConnectionState = {
  status: GatewayConnectionStatus;
  reconnectingSince?: number;
};
