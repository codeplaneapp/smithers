import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the Kimi for Coding OAuth token for an account from
 * `configDir/credentials/kimi-code.json` (the per-account `KIMI_SHARE_DIR`).
 * Kimi access tokens live ~15 minutes, so callers should expect
 * `expiresAtMs` to be in the past and refresh via `refreshKimiToken`.
 *
 * Returns `null` when no credential can be read. The token is returned only
 * to mint an outbound Authorization header or a refresh grant.
 *
 * @param {{ configDir?: string }} account
 * @returns {{ accessToken: string; refreshToken?: string; expiresAtMs?: number } | null}
 */
export function readKimiCredentials(account) {
  if (!account.configDir) return null;
  const path = join(account.configDir, "credentials", "kimi-code.json");
  if (!existsSync(path)) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  const refreshToken =
    typeof json?.refresh_token === "string" && json.refresh_token !== "" ? json.refresh_token : undefined;
  const expiresAtMs =
    typeof json?.expires_at === "number" && Number.isFinite(json.expires_at) ? json.expires_at * 1000 : undefined;
  return { accessToken, refreshToken, expiresAtMs };
}
