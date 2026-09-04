import type { JsonWebKey } from "./fetchJwks.ts";

interface JwksCacheEntry {
  fetchedAt?: number;
  keys?: JsonWebKey[];
  inFlight?: Promise<JsonWebKey[]>;
  lastMissRefreshAt?: number;
  lastRefreshFailure?: { at: number; kind: "inadmissible" } | { at: number; kind: "error"; error: unknown };
}

/**
 * Module-scoped JWKS cache shared by fetchJwks(). Tests reach in to clear it
 * between cases when they rotate the fixture keypair; production never does.
 */
export const jwksCache: Map<string, JwksCacheEntry> = new Map();
