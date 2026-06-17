import { parseClaudeOauthUsage } from "./parseClaudeOauthUsage.js";
import { readClaudeCredentials } from "./readClaudeCredentials.js";

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * The User-Agent must start with `claude-code/`; without it the endpoint drops
 * the caller into an aggressively rate-limited bucket. Overridable for when the
 * real installed version matters.
 */
const USER_AGENT = process.env.SMITHERS_CLAUDE_CODE_UA ?? "claude-code/2.0.0";

/**
 * Probes the Claude Code subscription usage endpoint for an account's 5-hour and
 * weekly utilization. Undocumented and best-effort: any failure degrades to a
 * `none` report with a readable reason.
 *
 * @param {{ configDir?: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function claudeOauthUsage(account) {
    const creds = readClaudeCredentials(account);
    if (!creds) {
        return { source: "none", error: "No Claude OAuth credentials in configDir or Keychain" };
    }
    if (typeof creds.expiresAt === "number" && creds.expiresAt <= Date.now()) {
        return { source: "none", error: "Claude OAuth token expired; run `claude` to refresh" };
    }
    try {
        const res = await fetch(USAGE_URL, {
            headers: {
                Authorization: `Bearer ${creds.accessToken}`,
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(6_000),
        });
        if (res.status === 401) {
            return { source: "none", error: "Claude OAuth token rejected (401); run `claude` to refresh" };
        }
        if (res.status === 429) {
            return { source: "none", error: "Claude usage endpoint rate limited (429); try again shortly" };
        }
        if (!res.ok) {
            return { source: "none", error: `Claude usage endpoint returned ${res.status}` };
        }
        const payload = await res.json();
        return { source: "oauth", windows: parseClaudeOauthUsage(payload) };
    } catch (err) {
        return { source: "none", error: `Claude usage probe failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
