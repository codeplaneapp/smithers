/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
import { fetchSearchJson } from "./searchHttp.js";

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch; allowedOrigins?: string[]; maxRedirects?: number; maxResponseBytes?: number; resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]> }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createBraveSearchProvider(options) {
  return {
    name: "brave",
    kind: "fresh",
    async search(input, execution = {}) {
      const params = new URLSearchParams({ q: input.query, count: String(input.maxResults) });
      const freshness = freshnessParam(input.freshness);
      if (freshness) params.set("freshness", freshness);
      const body = await fetchSearchJson(`${options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search"}?${params}`, {
        headers: {
          accept: "application/json",
          "x-subscription-token": options.apiKey,
        },
        signal: execution.signal,
      }, { ...options, provider: "Brave" });
      const results = Array.isArray(body.web?.results) ? body.web.results : [];
      return results.map((result) => ({
        title: String(result.title ?? result.url ?? "Untitled"),
        url: String(result.url ?? ""),
        snippet: result.description,
      })).filter((result) => result.url);
    },
  };
}

/** @param {string | undefined} freshness */
function freshnessParam(freshness) {
  if (freshness === "day") return "pd";
  if (freshness === "week") return "pw";
  if (freshness === "month") return "pm";
  if (freshness === "year") return "py";
  return undefined;
}
