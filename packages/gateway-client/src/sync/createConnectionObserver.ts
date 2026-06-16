import type { ConnectionObserver } from "./ConnectionObserver.ts";
import type { GatewayConnectionState } from "./GatewayConnectionState.ts";

export function createConnectionObserver(): ConnectionObserver {
  let state: GatewayConnectionState = { status: "idle" };
  const listeners = new Set<() => void>();
  const set = (next: GatewayConnectionState) => {
    if (next.status === state.status && next.reconnectingSince === state.reconnectingSince) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markConnecting: () => {
      if (state.status === "idle") set({ status: "connecting" });
    },
    markOnline: () => set({ status: "online" }),
    markOffline: () =>
      set({ status: "offline", reconnectingSince: state.reconnectingSince ?? Date.now() }),
    markUnauthorized: () => set({ status: "unauthorized" }),
    reset: () => set({ status: "idle" }),
  };
}
