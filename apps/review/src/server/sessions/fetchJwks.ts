import { jwksCache } from "./jwksCache.ts";

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Unknown kids and broken upstream responses may be attacker-controlled or
 * persistent. Throttle repeated miss refreshes and retries after a failed or
 * inadmissible response for five seconds, while still allowing a valid warm
 * cache's first kid miss to refresh immediately.
 */
export const JWKS_REFRESH_COOLDOWN_MS = 5_000;

export interface JsonWebKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export interface FetchJwksOptions {
  bypassCacheOnKidMiss?: boolean;
}

type ImportJwk = (
  format: "jwk",
  keyData: Record<string, unknown>,
  algorithm: { name: string; hash: string },
  extractable: boolean,
  keyUsages: readonly string[],
) => Promise<CryptoKey>;

/** Import a key with the exact algorithm parameters used by OIDC verification. */
export async function importRs256Jwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const { kty, n, e, kid, alg, use } = jwk;
  const keyData = { kty, n, e, kid, alg: alg ?? "RS256", use: use ?? "sig", ext: true };
  // tsc's lib doesn't declare JsonWebKey here; Workers and Bun accept the
  // standard JWK fields. Keep this shared with verifyOidc so cache admission
  // and signature verification cannot drift apart.
  return (crypto.subtle.importKey as unknown as ImportJwk)(
    "jwk",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function usableRs256Keys(body: unknown): Promise<JsonWebKey[] | null> {
  if (typeof body !== "object" || body === null || !("keys" in body)) return null;
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  const candidates: JsonWebKey[] = [];
  for (const key of keys) {
    if (typeof key !== "object" || key === null) return null;
    const candidate = key as Partial<JsonWebKey>;

    // A JWKS may legitimately publish keys for other algorithms or for
    // encryption. They are unrelated to this RS256 verifier and can be
    // ignored without making the whole document unusable.
    if (candidate.kty !== "RSA") continue;
    if (candidate.use !== undefined && typeof candidate.use !== "string") return null;
    if (candidate.use !== undefined && candidate.use !== "sig") continue;
    if (candidate.alg !== undefined && typeof candidate.alg !== "string") return null;
    if (candidate.alg !== undefined && candidate.alg !== "RS256") continue;

    if (
      typeof candidate.kid !== "string" ||
      candidate.kid.length === 0 ||
      typeof candidate.n !== "string" ||
      candidate.n.length === 0 ||
      typeof candidate.e !== "string" ||
      candidate.e.length === 0
    ) {
      return null;
    }
    candidates.push(candidate as JsonWebKey);
  }

  // A successful HTTP/JSON response is not enough to replace last-good keys:
  // every relevant candidate must also be importable by the verifier. An
  // empty/irrelevant-only document likewise cannot provide an RS256 key set.
  if (candidates.length === 0) return null;
  try {
    await Promise.all(candidates.map(importRs256Jwk));
  } catch {
    return null;
  }
  return candidates;
}

/**
 * GitHub Actions OIDC JWKS lookup, cached in-memory for the worker instance.
 * The discovery URL is injected by the worker so tests can point at a
 * Bun.serve fixture instead of token.actions.githubusercontent.com.
 */
export async function fetchJwks(
  url: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
  options: FetchJwksOptions = {},
): Promise<JsonWebKey[]> {
  const existing = jwksCache.get(url);
  const cached = existing ?? {};
  if (!existing) jwksCache.set(url, cached);

  const fresh = cached.keys !== undefined && cached.fetchedAt !== undefined && now - cached.fetchedAt < CACHE_TTL_MS;
  if (!options.bypassCacheOnKidMiss && fresh) return cached.keys ?? [];
  if (cached.inFlight) return cached.inFlight;

  const recentFailure = cached.lastRefreshFailure;
  if (recentFailure !== undefined && now - recentFailure.at < JWKS_REFRESH_COOLDOWN_MS) {
    if (recentFailure.kind === "error") throw recentFailure.error;
    return cached.keys ?? [];
  }

  if (options.bypassCacheOnKidMiss) {
    const lastAttempt = cached.lastMissRefreshAt;
    if (lastAttempt !== undefined && now - lastAttempt < JWKS_REFRESH_COOLDOWN_MS) {
      return cached.keys ?? [];
    }
    cached.lastMissRefreshAt = now;
  }

  const previousKeys = cached.keys;
  const request = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`jwks fetch ${url} timed out`);
          reject(error);
          controller.abort(error);
        }, FETCH_TIMEOUT_MS);
      });
      // Race through body consumption as well as fetch. Abort alone cannot
      // release waiters if an injected transport ignores the signal.
      const body = await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`jwks fetch ${url} returned ${response.status}`);
          }
          return response.json();
        })(),
        deadline,
      ]);
      clearTimeout(timer);
      const keys = await usableRs256Keys(body);
      if (keys === null) {
        cached.lastRefreshFailure = { at: now, kind: "inadmissible" };
        return previousKeys ?? [];
      }
      cached.fetchedAt = now;
      cached.keys = keys;
      cached.lastRefreshFailure = undefined;
      return keys;
    } catch (error) {
      cached.lastRefreshFailure = { at: now, kind: "error", error };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();
  cached.inFlight = request;
  try {
    return await request;
  } finally {
    if (cached.inFlight === request) cached.inFlight = undefined;
  }
}
