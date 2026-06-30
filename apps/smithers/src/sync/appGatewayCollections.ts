import {
  createSmithersGatewayTransport,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import {
  createGatewayCollections,
  type GatewayCollections,
} from "@smithers-orchestrator/gateway-react";
import { getGatewayClient } from "../gateway/gatewayClient";

/**
 * The app's `GatewayCollections` registry — the live TanStack-DB collections the
 * gateway-react hooks read from.
 *
 * Local-only: there is no OPFS/SQLite persistence cache and no Electric twin
 * (both exist in the cloud `multi` app for offline hydration and Postgres
 * sync). The live RPC + WebSocket path stands on its own; everything streams
 * from the local gateway.
 */
function makeTransport(): SyncTransport {
  return {
    rpc(method: string, params: unknown, options) {
      return getGatewayClient().rpcRaw(method, params, { signal: options?.signal });
    },
    stream(scope, params, options) {
      return createSmithersGatewayTransport(getGatewayClient()).stream!(scope, params, options);
    },
  };
}

export const appGatewayCollections: GatewayCollections = createGatewayCollections({
  client: makeTransport(),
  listGcTime: 5 * 60_000,
});
