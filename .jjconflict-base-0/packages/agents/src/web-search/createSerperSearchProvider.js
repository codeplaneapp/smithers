/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * @param {{ apiKey: string; baseUrl?: string; fetch?: typeof fetch }} options
 * @returns {GroundedWebSearchProvider}
 */
export function createSerperSearchProvider(options) {
  return {
    name: "serper",
    kind: "fresh",
    async search(input) {
      const fetchImpl = options.fetch ?? fetch;
      const response = await fetchWithSameOriginRedirects(
        fetchImpl,
        options.baseUrl ?? "https://google.serper.dev/search",
        {
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
        },
        "Serper",
      );
      const body = await readJson(response, "Serper");
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

/**
 * Follows redirects manually so the credential header never leaves the
 * requested origin: every Location hop is resolved and validated against the
 * origin of the initial request before the next request is sent, and a
 * cross-origin hop aborts the search instead of forwarding the API key.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} provider
 * @returns {Promise<Response>}
 */
async function fetchWithSameOriginRedirects(fetchImpl, url, init, provider) {
  const origin = new URL(url).origin;
  let currentUrl = url;
  /** @type {RequestInit} */
  let currentInit = { ...init, redirect: "manual" };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(currentUrl, currentInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== origin) {
      throw new Error(`${provider} search rejected a cross-origin redirect to ${nextUrl.origin}: credentials are only sent to ${origin}`);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentInit.method === "POST")) {
      currentInit = { ...currentInit, method: "GET", body: undefined };
    }
    currentUrl = nextUrl.href;
  }
  throw new Error(`${provider} search exceeded ${MAX_REDIRECTS} redirects for ${url}`);
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
