import type { GatewayConnectionState } from "./GatewayConnectionState.ts";

export type ConnectionObserver = {
  get(): GatewayConnectionState;
  subscribe(listener: () => void): () => void;
  markConnecting(): void;
  markOnline(): void;
  markOffline(): void;
  markUnauthorized(): void;
  reset(): void;
};
