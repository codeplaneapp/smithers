/**
 * ChatGPT-subscription (codex) auth for the server-side chat.
 *
 * The host's `codex` CLI authenticates the OpenAI Responses API as a ChatGPT
 * *subscriber* — NOT with an `sk-` API key against `api.openai.com`. Instead it
 * sends the OAuth **access_token** (a JWT, `aud: ["https://api.openai.com/v1"]`)
 * as a Bearer token to the ChatGPT-backed Responses endpoint:
 *
 *   POST https://chatgpt.com/backend-api/codex/responses
 *   Authorization: Bearer <access_token>
 *   chatgpt-account-id: <account_id>
 *   OpenAI-Beta: responses=experimental
 *   originator: codex_cli_rs
 *   session_id: <uuid>
 *   { ..., "store": false }   // backend REQUIRES store:false (else 400)
 *
 * The token lives in `~/.codex/auth.json` (the same file the codex CLI writes).
 * Its shape:
 *   { auth_mode: "chatgpt",
 *     tokens: { access_token, refresh_token, account_id, id_token },
 *     last_refresh }
 *
 * This module turns a credential (token + account id, or a refresh token) into
 * the base URL + Bearer + headers the worker needs, refreshing the access token
 * via the OAuth token endpoint when it is expired.
 */

/** ChatGPT-backed Responses endpoint base. The adapter appends `/responses`. */
export const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** OAuth token endpoint + client used by the codex CLI for refresh. */
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** The codex CLI's originator string; the backend keys quota/limits off it. */
const CODEX_ORIGINATOR = "codex_cli_rs";

/** A codex-subscription credential, as injected into the worker env. */
export type CodexSubscriptionCredential = {
  /** OAuth access token (Bearer). May be expired — call ensureFreshToken. */
  accessToken?: string;
  /** ChatGPT account id (sent as `chatgpt-account-id`). */
  accountId?: string;
  /** OAuth refresh token, used to mint a new access token when expired. */
  refreshToken?: string;
};

/** The materialized values the worker uses to call the Responses API. */
export type CodexResponsesAuth = {
  baseURL: string;
  /** Bearer token (a fresh, unexpired access token). */
  token: string;
  /** Default headers added to every Responses request. */
  headers: Record<string, string>;
};

/** Decode a JWT payload without verifying the signature (we only read claims). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the access token is missing or expires within `skewMs`. */
function isAccessTokenExpired(accessToken: string, skewMs = 60_000): boolean {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : 0;
  if (!exp) return true; // can't read exp → treat as expired, force refresh
  return exp * 1000 - skewMs <= Date.now();
}

/** Read the ChatGPT account id embedded in the access token's auth claim. */
function accountIdFromToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/**
 * Exchange a refresh token for a fresh access token at the codex OAuth endpoint.
 * Mirrors the codex CLI's refresh: client_id + grant_type=refresh_token, scope
 * "openid profile email". Returns the new access token (and refresh token if the
 * server rotated it). Throws with a clear message on failure.
 */
async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `codex token refresh failed (${res.status}): ${detail.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!json.access_token) {
    throw new Error("codex token refresh returned no access_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
  };
}

/**
 * Per-isolate cache of the most recently minted credential. The OAuth endpoint
 * MAY rotate the refresh token on each refresh; once it does, the original
 * env-provided refresh token can stop working, so we must remember the rotated
 * one. Caching the access token (and reading its `exp`) also means a
 * refresh-token-only deployment refreshes once per token lifetime instead of on
 * every request. State is per-isolate, which is safe because the env credential
 * is fixed for an isolate's lifetime — a fresh isolate starts with an empty
 * cache and re-derives from env.
 */
let cachedCodexAuth: { accessToken: string; refreshToken: string } | null = null;

/**
 * Materialize a ChatGPT-subscription credential into a ready-to-use Responses
 * auth (base URL + fresh Bearer + headers), refreshing the access token if it is
 * expired and a refresh token is available. Returns `null` when no usable
 * credential is present so the caller can fall back to the API-key path.
 *
 * Throws only when a credential IS present but cannot be made usable (e.g.
 * expired with no/failed refresh) — so the worker fails *clearly* rather than
 * silently falling back to a missing API key.
 */
export async function resolveCodexResponsesAuth(
  credential: CodexSubscriptionCredential | undefined,
): Promise<CodexResponsesAuth | null> {
  if (!credential) return null;
  const { accessToken: envAccessToken, refreshToken: envRefreshToken } = credential;
  // Prefer a refresh token we rotated to over the (possibly invalidated) env one.
  const refreshToken = cachedCodexAuth?.refreshToken ?? envRefreshToken;

  let accessToken: string;
  if (cachedCodexAuth && !isAccessTokenExpired(cachedCodexAuth.accessToken)) {
    // A token we minted earlier is still valid — reuse it, no refresh round-trip.
    accessToken = cachedCodexAuth.accessToken;
  } else if (envAccessToken && !isAccessTokenExpired(envAccessToken)) {
    // The env-provided access token is still good.
    accessToken = envAccessToken;
  } else if (refreshToken) {
    // Mint a fresh token and remember it (plus any rotated refresh token) so the
    // next request neither re-refreshes nor reuses a rotated-away refresh token.
    const refreshed = await refreshAccessToken(refreshToken);
    cachedCodexAuth = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    };
    accessToken = refreshed.accessToken;
  } else if (envAccessToken) {
    // Have an (expired) access token but no way to refresh → fail clearly.
    throw new Error(
      "codex subscription access token is expired and no refresh token was " +
        "provided. Re-run `codex login` (or refresh ~/.codex/auth.json) so the " +
        "worker has a valid ChatGPT-subscription token.",
    );
  } else {
    return null; // nothing usable → caller falls back to the API-key path
  }

  const accountId = credential.accountId ?? accountIdFromToken(accessToken);

  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    // A per-process session id; the backend uses it as the prompt cache key.
    session_id: crypto.randomUUID(),
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }

  return { baseURL: CODEX_RESPONSES_BASE_URL, token: accessToken, headers };
}

/**
 * Extract the codex-subscription credential from the worker env, if present.
 * The harness injects these (read from ~/.codex/auth.json); in production they'd
 * be Cloudflare secrets. Returns `undefined` when no subscription field is set.
 */
export function codexCredentialFromEnv(env: {
  CODEX_ACCESS_TOKEN?: string;
  CODEX_ACCOUNT_ID?: string;
  CODEX_REFRESH_TOKEN?: string;
}): CodexSubscriptionCredential | undefined {
  const accessToken = env.CODEX_ACCESS_TOKEN?.trim() || undefined;
  const refreshToken = env.CODEX_REFRESH_TOKEN?.trim() || undefined;
  const accountId = env.CODEX_ACCOUNT_ID?.trim() || undefined;
  if (!accessToken && !refreshToken) return undefined;
  return { accessToken, accountId, refreshToken };
}
