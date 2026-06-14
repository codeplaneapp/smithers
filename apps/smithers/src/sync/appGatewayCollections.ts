import {
  SyncClient,
  createSmithersGatewayTransport,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import { handleAuthRequired } from "../auth/authClient";
import { getGatewayClient } from "../gateway/gatewayClient";

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

export const appGatewayCollections = new SyncClient({
  transport: makeTransport(),
  cache: {
    cacheTimeMs: 5 * 60_000,
  },
  subscription: {
    bufferMax: 1024,
  },
  onAuthError: () => {
    handleAuthRequired();
  },
});
