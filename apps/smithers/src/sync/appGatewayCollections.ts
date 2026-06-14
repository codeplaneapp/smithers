import {
  createSmithersGatewayTransport,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import { createGatewayCollections } from "@smithers-orchestrator/gateway-react";
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

// The TanStack DB collections registry handed to `<SyncProvider>`. Built over the
// app's instrumented `getGatewayClient()` transport so auth/CSRF/same-origin
// proxying/observability stay in one place. `RemoteModePanel` calls `.reset()` on
// a remote-mode swap to drop cached collections and re-probe the connection.
export const appGatewayCollections = createGatewayCollections({
  client: makeTransport(),
  onAuthError: () => {
    handleAuthRequired();
  },
  listGcTime: 5 * 60_000,
});
