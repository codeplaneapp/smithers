/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */
import { fetchSearchJson } from "./searchHttp.js";

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch; allowedOrigins?: string[]; maxRedirects?: number; maxResponseBytes?: number; resolveHostname?: (hostname: string) => readonly string[] | Promise<readonly string[]> }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createSerperSearchProvider(options) {
  return {
    name: "serper",
    kind: "fresh",
    async search(input, execution = {}) {
      const body = await fetchSearchJson(options.baseUrl ?? "https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify({
          q: input.query,
          num: input.maxResults,
          ...freshnessParams(input.freshness),
        }),
        signal: execution.signal,
      }, { ...options, provider: "Serper" });
      const results = Array.isArray(body.organic) ? body.organic : [];
      return results.map((result) => ({
        title: String(result.title ?? result.link ?? "Untitled"),
        url: String(result.link ?? ""),
        snippet: result.snippet,
        publishedDate: result.date,
      })).filter((result) => result.url);
    },
  };
}

/** @param {string | undefined} freshness */
function freshnessParams(freshness) {
  const tbs = freshnessTbs(freshness);
  return tbs ? { tbs } : {};
}

/** @param {string | undefined} freshness */
function freshnessTbs(freshness) {
  if (freshness === "day") return "qdr:d";
  if (freshness === "week") return "qdr:w";
  if (freshness === "month") return "qdr:m";
  if (freshness === "year") return "qdr:y";
  return undefined;
}
