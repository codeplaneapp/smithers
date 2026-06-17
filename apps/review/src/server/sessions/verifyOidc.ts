import { fetchJwks, type JsonWebKey as ReviewJwk } from "./fetchJwks.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "smithers-review";

/**
 * GitHub Actions OIDC claims the worker reads. Other claims may appear in the
 * token but are ignored: identity comes from `repository`, the PR number (when
 * inferrable) from `event_name` + `ref`.
 */
export interface OidcClaims {
  iss: string;
  aud: string;
  exp: number;
  iat?: number;
  repository: string;
  repository_owner?: string;
  repository_id?: string;
  ref?: string;
  ref_type?: string;
  event_name?: string;
  pull_request?: { number?: number };
}

export interface OidcVerifyResult {
  ok: true;
  claims: OidcClaims;
}

export interface OidcVerifyFailure {
  ok: false;
  reason:
    | "malformed"
    | "unsupported-alg"
    | "unknown-key"
    | "bad-signature"
    | "wrong-issuer"
    | "wrong-audience"
    | "expired";
}

export type OidcVerifyOutcome = OidcVerifyResult | OidcVerifyFailure;

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin = atob(padded);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToJson<T>(input: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T;
  } catch {
    return null;
  }
}

type ImportJwk = (
  format: "jwk",
  keyData: Record<string, unknown>,
  algorithm: { name: string; hash: string },
  extractable: boolean,
  keyUsages: readonly string[],
) => Promise<CryptoKey>;

async function importJwk(jwk: ReviewJwk): Promise<CryptoKey> {
  const { kty, n, e, kid, alg, use } = jwk;
  const keyData = { kty, n, e, kid, alg: alg ?? "RS256", use: use ?? "sig", ext: true };
  // tsc's lib doesn't declare JsonWebKey here; the runtime (Workers, Bun)
  // accepts the standard jwk fields. Cast the function signature once and
  // keep the call site readable.
  return (crypto.subtle.importKey as unknown as ImportJwk)(
    "jwk",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify a GitHub Actions OIDC token against the JWKS at `jwksUrl`. Returns a
 * tagged result instead of throwing: callers can map failure reasons to
 * specific HTTP statuses without try/catch flow.
 */
export async function verifyOidc(
  token: string,
  jwksUrl: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcVerifyOutcome> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [rawHeader, rawPayload, rawSig] = parts;
  const header = base64UrlToJson<{ alg?: string; kid?: string }>(rawHeader);
  const payload = base64UrlToJson<OidcClaims>(rawPayload);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported-alg" };

  const keys = await fetchJwks(jwksUrl, now, fetchImpl);
  const match = keys.find((k) => k.kid === header.kid);
  if (!match) return { ok: false, reason: "unknown-key" };

  const key = await importJwk(match);
  const signature = base64UrlToBytes(rawSig);
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature.buffer as ArrayBuffer,
    signed.buffer as ArrayBuffer,
  );
  if (!ok) return { ok: false, reason: "bad-signature" };

  if (payload.iss !== ISSUER) return { ok: false, reason: "wrong-issuer" };
  if (payload.aud !== AUDIENCE) return { ok: false, reason: "wrong-audience" };
  const expMs = payload.exp * 1000;
  if (!Number.isFinite(expMs) || expMs <= now) return { ok: false, reason: "expired" };

  return { ok: true, claims: payload };
}
