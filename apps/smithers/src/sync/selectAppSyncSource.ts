import { createGatewaySyncSource, type SyncSource, type SyncTransport } from "@smithers-orchestrator/gateway-client";
import type { SyncSourceHooks } from "@smithers-orchestrator/gateway-react";
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
 * Phase 2 ships a single source: the local gateway transport, which reads
 * through `SmithersDb` and so works against SQLite/PGlite/Postgres unchanged.
 * Phase 7 adds `createElectricCollection` for the `platform` (cloud) backend;
 * the switch below is where it plugs in, with no change to any consuming UI.
 */
export function selectAppSyncSource(options: SelectAppSyncSourceOptions): SyncSource {
  const mode = useBackendStore.getState().mode;
  switch (mode) {
    // Phase 7: `platform` (cloud jjhub) will return the Electric source here.
    case "platform":
    case "gateway":
    default:
      return createGatewaySyncSource({ transport: options.transport, ...options.hooks });
  }
}
