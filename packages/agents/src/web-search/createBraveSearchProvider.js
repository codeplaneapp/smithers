/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createBraveSearchProvider(options) {
  return {
    name: "brave",
    kind: "fresh",
    async search(input) {
      const fetchImpl = options.fetch ?? fetch;
      const params = new URLSearchParams({ q: input.query, count: String(input.maxResults) });
      const freshness = freshnessParam(input.freshness);
      if (freshness) params.set("freshness", freshness);
      const response = await fetchImpl(`${options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search"}?${params}`, {
        headers: {
          accept: "application/json",
          "x-subscription-token": options.apiKey,
        },
      });
      const body = await readJson(response, "Brave");
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
