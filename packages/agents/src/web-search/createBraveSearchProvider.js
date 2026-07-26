/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
      const response = await fetchWithSameOriginRedirects(
        fetchImpl,
        `${options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search"}?${params}`,
        {
          headers: {
            accept: "application/json",
            "x-subscription-token": options.apiKey,
          },
        },
        "Brave",
      );
      const body = await readJson(response, "Brave");
      const results = Array.isArray(body.web?.results) ? body.web.results : [];
      return results
        .map((result) => ({
          title: String(result.title ?? result.url ?? "Untitled"),
          url: String(result.url ?? ""),
          snippet: result.description,
        }))
        .filter((result) => result.url);
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
      throw new Error(
        `${provider} search rejected a cross-origin redirect to ${nextUrl.origin}: credentials are only sent to ${origin}`,
      );
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && currentInit.method === "POST")
    ) {
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
