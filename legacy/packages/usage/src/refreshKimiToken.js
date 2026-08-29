import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

/** Refresh must fail fast: it blocks the usage probe, which itself fails fast. */
const REFRESH_TIMEOUT_MS = 6_000;

/**
 * @typedef {object} KimiRefreshSuccess
 * @property {true} ok
 * @property {string} accessToken
 * @property {number | undefined} expiresAtMs
 */

/**
 * @typedef {object} KimiRefreshFailure
 * @property {false} ok
 * @property {string} error
 * @property {boolean} reauth True when the refresh grant is dead and the user must re-login.
 */

/**
 * Refreshes a Kimi for Coding OAuth token against
 * `POST {KIMI_CODE_OAUTH_HOST|KIMI_OAUTH_HOST|auth.kimi.com}/api/oauth/token`
 * (the same client_id and grant the official kimi CLI uses) and persists the
 * rotated tokens back to `credentials/kimi-code.json` so the CLI keeps working.
 *
 * Refresh tokens rotate on every refresh. Before writing, the credentials file
 * is re-read: when another process (a running kimi CLI) already rotated the
 * grant, the on-disk tokens win and the just-refreshed pair is discarded —
 * writing ours would orphan the file's newer refresh token.
 *
 * @param {{ configDir?: string }} account
 * @param {string} refreshToken
 * @returns {Promise<KimiRefreshSuccess | KimiRefreshFailure>}
 */
export async function refreshKimiToken(account, refreshToken) {
  const host = (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || DEFAULT_OAUTH_HOST).replace(
    /\/+$/,
    "",
  );
  /** @type {Record<string, unknown>} */
  let data;
  try {
    const res = await fetch(`${host}/api/oauth/token`, {
      method: "POST",
      headers: { "X-Msh-Platform": "kimi_cli" },
      body: new URLSearchParams({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    data = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return {
        ok: false,
        reauth: true,
        error: "Kimi OAuth refresh rejected; run `kimi` and /login to re-authenticate",
      };
    }
    if (!res.ok) {
      return { ok: false, reauth: false, error: `Kimi token refresh returned ${res.status}` };
    }
  } catch (err) {
    return {
      ok: false,
      reauth: false,
      error: `Kimi token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const accessToken = data.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    return { ok: false, reauth: false, error: "Kimi token refresh returned no access_token" };
  }
  const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? data.expires_in : 900;
  const next = {
    access_token: accessToken,
    refresh_token:
      typeof data.refresh_token === "string" && data.refresh_token !== "" ? data.refresh_token : refreshToken,
    expires_at: Date.now() / 1000 + expiresIn,
    expires_in: expiresIn,
    scope: typeof data.scope === "string" ? data.scope : "kimi-code",
    token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
  };

  persist(account, next, refreshToken);
  return { ok: true, accessToken, expiresAtMs: next.expires_at * 1000 };
}

/**
 * @param {{ configDir?: string }} account
 * @param {Record<string, unknown>} next
 * @param {string} sentRefreshToken
 */
function persist(account, next, sentRefreshToken) {
  if (!account.configDir) return;
  const dir = join(account.configDir, "credentials");
  const path = join(dir, "kimi-code.json");
  try {
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    if (typeof onDisk?.refresh_token === "string" && onDisk.refresh_token !== sentRefreshToken) return;
  } catch {
    // Unreadable file: fall through and write the pair we just minted.
  }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.kimi-code.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A failed persist only means the next probe refreshes again.
  }
}
