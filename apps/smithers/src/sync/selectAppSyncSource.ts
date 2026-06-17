import { createElectricSyncSource, createGatewaySyncSource, type SyncSource, type SyncTransport } from "@smithers-orchestrator/gateway-client";
import type { SyncSourceHooks } from "@smithers-orchestrator/gateway-react";
import { getStoredAuthorization } from "../auth/authClient";
import { useBackendStore } from "../app/backendStore";

type SelectAppSyncSourceOptions = {
  transport: SyncTransport;
  hooks: SyncSourceHooks;
};

/**
 * Pick the pluggable `SyncSource` at app boot from `backendStore`, the keystone
 * of the design's "one UI surface over a pluggable sync source" (§5.1). The
 * choice is made once here so UIs import collections/hooks and never a source.
 *
 * The local gateway transport reads through `SmithersDb` and works against
 * SQLite/PGlite/Postgres unchanged. The platform backend uses Electric shapes
 * for reads and the Gateway write endpoint for txid-matched mutations.
 */
export function selectAppSyncSource(options: SelectAppSyncSourceOptions): SyncSource {
  const mode = useBackendStore.getState().mode;
  const appOrigin = typeof location === "undefined" ? "" : location.origin;
  // ElectricSQL runs as a SEPARATE cloud service fronted by the
  // smithers-electric-proxy at its own URL — it is NOT served same-origin by the
  // app worker (which only forwards /v1/rpc, /v1/electric/write, /workflows,
  // /health). So the Electric read source is selected ONLY when its proxy URL is
  // explicitly configured; otherwise platform mode falls back to the gateway
  // transport (served same-origin) so the default app path never points at an
  // unserved /v1/shape. The write endpoint IS a same-origin gateway route.
  const electricProxyUrl = import.meta.env.VITE_SMITHERS_ELECTRIC_PROXY_URL;
  if (mode === "platform" && electricProxyUrl) {
    return createElectricSyncSource({
      shapeUrl: electricProxyUrl,
      writeUrl: import.meta.env.VITE_SMITHERS_ELECTRIC_WRITE_URL || `${appOrigin}/v1/electric/write`,
      headers: {
        authorization: () => {
          const authorization = getStoredAuthorization();
          return authorization ?? "";
        },
      },
      fallbackTransport: options.transport,
      ...options.hooks,
    });
  }
  return createGatewaySyncSource({ transport: options.transport, ...options.hooks });
}
