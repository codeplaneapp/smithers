/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
import { fetchSearchJson } from "./searchHttp.js";

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch; allowedOrigins?: string[]; maxRedirects?: number; maxResponseBytes?: number; resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]> }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createExaSearchProvider(options) {
  return {
    name: "exa",
    kind: "semantic",
    async search(input, execution = {}) {
      const body = await fetchSearchJson(`${options.baseUrl ?? "https://api.exa.ai"}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify({
          query: input.query,
          numResults: input.maxResults,
          useAutoprompt: true,
          ...freshnessParams(input.freshness),
        }),
        signal: execution.signal,
      }, { ...options, provider: "Exa" });
      const results = Array.isArray(body.results) ? body.results : [];
      return results.map((result) => ({
        title: String(result.title ?? result.url ?? "Untitled"),
        url: String(result.url ?? ""),
        snippet: typeof result.text === "string" ? result.text : result.summary,
        publishedDate: result.publishedDate,
        score: typeof result.score === "number" ? result.score : undefined,
      })).filter((result) => result.url);
    },
  };
}

/** @param {string | undefined} freshness */
function freshnessParams(freshness) {
  const days = freshnessDays(freshness);
  return days ? { startPublishedDate: isoDateDaysAgo(days) } : {};
}

/** @param {string | undefined} freshness */
function freshnessDays(freshness) {
  if (freshness === "day") return 1;
  if (freshness === "week") return 7;
  if (freshness === "month") return 30;
  if (freshness === "year") return 365;
  return undefined;
}

/** @param {number} days */
function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
