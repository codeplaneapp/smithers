/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createTavilySearchProvider(options) {
  return {
    name: "tavily",
    kind: "fresh",
    async search(input) {
      const fetchImpl = options.fetch ?? fetch;
      const response = await fetchImpl(`${options.baseUrl ?? "https://api.tavily.com"}/search`, {
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
      });
      const body = await readJson(response, "Tavily");
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

/**
 * @param {Response} response
 * @param {string} provider
 * @returns {Promise<any>}
 */
async function readJson(response, provider) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${provider} search failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}
