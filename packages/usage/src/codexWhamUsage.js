import { parseCodexUsage } from "./parseCodexUsage.js";
import { readCodexCredentials } from "./readCodexCredentials.js";

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * Probes the Codex ChatGPT-subscription usage endpoint for an account's 5-hour
 * and weekly windows. This is the same data the Codex `/status` view shows and
 * does not spend a turn. Undocumented and best-effort.
 *
 * @param {{ configDir?: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function codexWhamUsage(account) {
    const creds = readCodexCredentials(account);
    if (!creds) {
        return { source: "none", error: "No Codex ChatGPT credentials in configDir/auth.json" };
    }
    try {
        /** @type {Record<string, string>} */
        const headers = {
            Authorization: `Bearer ${creds.accessToken}`,
            "User-Agent": "codex-cli",
            Accept: "application/json",
        };
        if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
        const res = await fetch(USAGE_URL, {
            headers,
            signal: AbortSignal.timeout(6_000),
        });
        if (res.status === 401) {
            return { source: "none", error: "Codex token rejected (401); run `codex` to refresh" };
        }
        if (!res.ok) {
            return { source: "none", error: `Codex usage endpoint returned ${res.status}` };
        }
        const payload = await res.json();
        const { windows, planType, credits } = parseCodexUsage(payload);
        return { source: "oauth", windows, planType, credits };
    } catch (err) {
        return { source: "none", error: `Codex usage probe failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
