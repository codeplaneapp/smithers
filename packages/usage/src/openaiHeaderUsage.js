import { parseOpenAiRateLimitHeaders } from "./parseOpenAiRateLimitHeaders.js";

/** @typedef {import("./buildUsageReport.js").UsageProbe} UsageProbe */

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

/**
 * `GET /v1/models` does not return rate-limit headers; only a model request
 * does. This minimal completion costs one request and a single output token,
 * which is the cheapest documented way to read the headers.
 */
const PROBE_MODEL = process.env.SMITHERS_OPENAI_PROBE_MODEL ?? "gpt-4o-mini";

/**
 * Reads live OpenAI rate-limit headers for an API-key account.
 *
 * @param {{ apiKey?: string }} account
 * @returns {Promise<UsageProbe>}
 */
export async function openaiHeaderUsage(account) {
    const apiKey = account.apiKey;
    if (!apiKey) {
        return { source: "none", error: "Account has no API key set" };
    }
    try {
        const res = await fetch(CHAT_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: PROBE_MODEL,
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(6_000),
        });
        if (res.status === 401) {
            return { source: "none", error: "OPENAI_API_KEY rejected (401)" };
        }
        const get = (name) => res.headers.get(name);
        const windows = parseOpenAiRateLimitHeaders(get);
        if (res.status === 429) {
            const retryAfter = res.headers.get("retry-after");
            return {
                source: "headers",
                windows,
                error: `Rate limited (429)${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
            };
        }
        if (!res.ok && windows.length === 0) {
            return { source: "none", error: `OpenAI returned ${res.status} with no rate-limit headers` };
        }
        return { source: "headers", windows };
    } catch (err) {
        return { source: "none", error: `OpenAI header probe failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}
