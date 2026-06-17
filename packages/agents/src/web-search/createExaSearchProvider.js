/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createExaSearchProvider(options) {
  return {
    name: "exa",
    kind: "semantic",
    async search(input) {
      const fetchImpl = options.fetch ?? fetch;
      const response = await fetchImpl(`${options.baseUrl ?? "https://api.exa.ai"}/search`, {
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
      });
      const body = await readJson(response, "Exa");
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
