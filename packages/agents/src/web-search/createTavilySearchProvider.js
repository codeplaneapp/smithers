/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
import { fetchSearchJson } from "./searchHttp.js";

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch; allowedOrigins?: string[]; maxRedirects?: number; maxResponseBytes?: number; resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]> }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createTavilySearchProvider(options) {
  return {
    name: "tavily",
    kind: "fresh",
    async search(input, execution = {}) {
      const body = await fetchSearchJson(`${options.baseUrl ?? "https://api.tavily.com"}/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          query: input.query,
          max_results: input.maxResults,
          topic: input.freshness ? "news" : "general",
          days: freshnessDays(input.freshness),
        }),
        signal: execution.signal,
      }, { ...options, provider: "Tavily" });
      const results = Array.isArray(body.results) ? body.results : [];
      return results.map((result) => ({
        title: String(result.title ?? result.url ?? "Untitled"),
        url: String(result.url ?? ""),
        snippet: result.content,
        publishedDate: result.published_date,
        score: typeof result.score === "number" ? result.score : undefined,
      })).filter((result) => result.url);
    },
  };
}

/** @param {string | undefined} freshness */
function freshnessDays(freshness) {
  if (freshness === "day") return 1;
  if (freshness === "week") return 7;
  if (freshness === "month") return 30;
  if (freshness === "year") return 365;
  return undefined;
}
