import {
  createSmithersGatewayTransport,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import { createGatewayCollections, type PersistenceAdapter } from "@smithers-orchestrator/gateway-react";
import { handleAuthRequired } from "../auth/authClient";
import { getGatewayClient } from "../gateway/gatewayClient";
import { scopedClientSchemaVersion } from "./scopedClientSchemaVersion";
import { selectAppSyncSource } from "./selectAppSyncSource";

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

// One OPFS-JSON adapter instance shared across every collection. Constructing a
// fresh adapter per collection (the old lazy-per-collection wiring) gave each
// one its own in-memory snapshot, so concurrent collections clobbered each
// other's durable rows. The registry memoizes this thunk, but keeping the
// singleton here makes the intent explicit and survives a registry rebuild.
let adapterPromise: Promise<PersistenceAdapter> | undefined;
function sharedPersistenceAdapter(): Promise<PersistenceAdapter> {
  return (adapterPromise ??= import("@smithers-orchestrator/gateway-react/opfsJsonPersistenceAdapter").then((module) =>
    module.createOpfsJsonPersistenceAdapter({ name: "smithers-client-sync" })
  ));
}

// The TanStack DB collections registry handed to `<SyncProvider>`. The sync
// source is chosen at boot from `backendStore` (the pluggable-source seam,
// §5.1) and wired with the registry's per-collection status hooks so load
// errors surface. Built over the app's instrumented `getGatewayClient()`
// transport so auth/CSRF/same-origin proxying/observability stay in one place.
// `RemoteModePanel` calls `.reset()` on a remote-mode swap to drop cached
// collections, the persisted adapter, and re-probe the connection.
export const appGatewayCollections = createGatewayCollections({
  createSource: (hooks) => selectAppSyncSource({ transport: makeTransport(), hooks }),
  client: makeTransport(),
  onAuthError: () => {
    handleAuthRequired();
  },
  listGcTime: 5 * 60_000,
  // A thunk, not a constant: resolved per collection at sync start so the cache
  // is scoped to the live backend identity (clears stale rows on a backend swap).
  schemaVersion: scopedClientSchemaVersion,
  persistence: sharedPersistenceAdapter,
});
