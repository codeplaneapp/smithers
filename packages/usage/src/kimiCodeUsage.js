import { parseKimiUsage } from "./parseKimiUsage.js";
import { readKimiCredentials } from "./readKimiCredentials.js";
import { refreshKimiToken } from "./refreshKimiToken.js";

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";

/** Probes must fail fast: `smithers usage` fans out over every account and a hung probe stalls the whole table. */
const PROBE_TIMEOUT_MS = 6_000;

/** Refresh when the access token dies within this window; Kimi tokens live ~15 minutes. */
const REFRESH_THRESHOLD_MS = 60_000;

/**
 * Probes the Kimi for Coding usage endpoint (`GET /coding/v1/usages`) for an
 * account's weekly quota, shorter rate windows, and parallel-session count.
 * This is the same data the kimi CLI's `/usage` command shows. Kimi access
 * tokens expire after ~15 minutes, so an expired token is refreshed with the
 * on-disk refresh token first. Undocumented and best-effort.
 *
 * @param {{ configDir?: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function kimiCodeUsage(account) {
  const creds = readKimiCredentials(account);
  if (!creds) {
    return { source: "none", error: "No Kimi OAuth credentials in configDir/credentials/kimi-code.json" };
  }

  let accessToken = creds.accessToken;
  const expired = creds.expiresAtMs === undefined || creds.expiresAtMs - REFRESH_THRESHOLD_MS < Date.now();
  if (expired) {
    if (!creds.refreshToken) {
      return { source: "none", error: "Kimi OAuth token expired and no refresh token on disk; run `kimi` and /login" };
    }
    const refreshed = await refreshKimiToken(account, creds.refreshToken);
    if (!refreshed.ok) return { source: "none", error: refreshed.error };
    accessToken = refreshed.accessToken;
  }

  const baseUrl = (process.env.KIMI_CODE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/usages`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401) {
      return { source: "none", error: "Kimi token rejected (401); run `kimi` and /login to refresh" };
    }
    if (!res.ok) {
      return { source: "none", error: `Kimi usage endpoint returned ${res.status}` };
    }
    const payload = await res.json();
    const { windows, planType } = parseKimiUsage(payload);
    return { source: "oauth", windows, planType };
  } catch (err) {
    return { source: "none", error: `Kimi usage probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
