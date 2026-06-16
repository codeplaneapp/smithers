import { useAuthStore } from "../auth/authStore";
import { useBackendStore } from "../app/backendStore";
import { gatewayClientSchemaVersion } from "./gatewayClientSchemaVersion";

/**
 * The persisted-collection schema version, SCOPED to the backend identity.
 *
 * `persistedCollectionOptions` clears the local SQLite/OPFS copy whenever this
 * string changes (design §5.4 / §9.3 cold-resync lever). Folding the backend
 * identity into it means a client pointed at a different gateway (or flipped
 * between the local `gateway` and cloud `platform` sources) can never warm-start
 * from rows that belonged to a different backend: the version no longer matches,
 * so the stale copy is wiped before the first row is read. Without this, the
 * cache name was a single global string and a backend swap surfaced the previous
 * backend's runs until live data overwrote them.
 *
 * Scope dimensions are limited to values that are BOTH stable across a reload
 * and available synchronously at boot: the backend `mode` and the resolved
 * gateway base URL (both persisted to localStorage). The signed-in user is
 * deliberately excluded — it resolves asynchronously after the auth bootstrap,
 * so a collection's first sync would race it and clear the cache
 * non-deterministically. User-identity changes drop the durable copy through
 * `appGatewayCollections.reset()` on the remote-mode swap instead.
 */
export function scopedClientSchemaVersion(): string {
  const mode = useBackendStore.getState().mode;
  const baseUrl = useAuthStore.getState().gatewayBaseUrl || "same-origin";
  return `${gatewayClientSchemaVersion}|${mode}|${baseUrl}`;
}
