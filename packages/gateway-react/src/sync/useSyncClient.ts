import { useContext } from "react";
import { SyncContext } from "./SyncContext.ts";
import type { GatewayCollections } from "./GatewayCollections.ts";

/**
 * The hook every other sync hook calls. Throws an explicit error when used
 * outside `<SyncProvider>` — a silent fallback would hide a wiring bug behind
 * confusing "data is undefined" symptoms.
 */
export function useSyncClient(): GatewayCollections {
  const client = useContext(SyncContext);
  if (!client) {
    throw new Error("useSyncClient: missing <SyncProvider>. Wrap your tree in a SyncProvider.");
  }
  return client;
}
