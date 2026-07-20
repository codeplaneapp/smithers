import { anthropicHeaderUsage } from "./anthropicHeaderUsage.js";
import { buildUsageReport } from "./buildUsageReport.js";
import { claudeOauthUsage } from "./claudeOauthUsage.js";
import { codexWhamUsage } from "./codexWhamUsage.js";
import { googleUsage } from "./googleUsage.js";
import { openaiHeaderUsage } from "./openaiHeaderUsage.js";

/** @typedef {import("@smithers-orchestrator/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */

/**
 * Routes an account to its usage adapter and returns a normalized report. This
 * switch mirrors `accountToProviderEnv` in the accounts package so the two stay
 * structurally aligned. Adapters never throw; they degrade to a `none` report.
 *
 * Credentials are read on the host that owns them and only the normalized report
 * leaves this function — no token is ever returned or logged.
 *
 * @param {Account} account
 * @returns {Promise<UsageReport>}
 */
export async function getAccountUsage(account) {
    const probe = await probeFor(account);
    return buildUsageReport(account, probe);
}

/**
 * @param {Account} account
 * @returns {Promise<import("./buildUsageReport.js").UsageProbe>}
 */
async function probeFor(account) {
    switch (account.provider) {
        case "claude-code":
            return claudeOauthUsage(account);
        case "codex":
            return codexWhamUsage(account);
        case "anthropic-api":
            return anthropicHeaderUsage(account);
        case "openai-api":
            return openaiHeaderUsage(account);
        case "antigravity":
        case "gemini-api":
            return googleUsage(account);
        case "kimi":
            return { source: "none", error: "Kimi exposes no usage endpoint yet" };
        default:
            return { source: "none", error: `Usage not supported for provider "${account.provider}"` };
    }
}
