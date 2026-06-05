import { parseAnthropicRateLimitHeaders } from "./parseAnthropicRateLimitHeaders.js";

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

/** The count_tokens probe needs a valid model id but generates no output tokens. */
const PROBE_MODEL = process.env.SMITHERS_ANTHROPIC_PROBE_MODEL ?? "claude-sonnet-4-20250514";

/**
 * Reads live Anthropic rate-limit headers for an API-key account. Uses the
 * `count_tokens` endpoint, which returns the rate-limit header family without
 * producing output tokens.
 *
 * @param {{ apiKey?: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function anthropicHeaderUsage(account) {
    const apiKey = account.apiKey;
    if (!apiKey) {
        return { source: "none", error: "Account has no API key set" };
    }
    try {
        const res = await fetch(COUNT_TOKENS_URL, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({ model: PROBE_MODEL, messages: [{ role: "user", content: "hi" }] }),
            signal: AbortSignal.timeout(6_000),
        });
        if (res.status === 401) {
            return { source: "none", error: "ANTHROPIC_API_KEY rejected (401)" };
        }
        const get = (name) => res.headers.get(name);
        const windows = parseAnthropicRateLimitHeaders(get);
        if (res.status === 429) {
            const retryAfter = res.headers.get("retry-after");
            return {
                source: "headers",
                windows,
                error: `Rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
            };
        }
        return { source: "headers", windows };
    } catch (err) {
        return { source: "none", error: `Anthropic header probe failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
