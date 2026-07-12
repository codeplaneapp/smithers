/** @typedef {import("./GroundedWebSearchProvider.ts").GroundedWebSearchProvider} GroundedWebSearchProvider */

const MAX_REDIRECTS = 5;

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
      const response = await fetchWithSameOriginRedirects(fetchImpl, `${options.baseUrl ?? "https://api.exa.ai"}/search`, {
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

/**
 * Follow redirects manually so the `x-api-key` header never rides an
 * automatically-followed hop to another origin. Every `Location` hop is
 * resolved against the current URL and validated: same-origin redirects are
 * followed (up to {@link MAX_REDIRECTS}), while a cross-origin hop fails
 * closed instead of leaking the credential to an untrusted host.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ method: string; headers: Record<string, string>; body?: string }} init
 * @returns {Promise<Response>}
 */
async function fetchWithSameOriginRedirects(fetchImpl, url, init) {
  let current = new URL(url);
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, { ...init, method, body, redirect: "manual" });
    if (!isRedirectStatus(response.status)) return response;
    const location = response.headers.get("location");
    // A redirect status without a Location header is not followable; surface
    // the response as-is (matching fetch semantics).
    if (!location) return response;
    /** @type {URL} */
    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`Exa search redirect returned an invalid Location header: ${location}`);
    }
    if (next.origin !== current.origin) {
      throw new Error(
        `Exa search redirected cross-origin from ${current.origin} to ${next.origin}; refusing to forward the API key`,
      );
    }
    // Mirror fetch redirect semantics: 303 (and 301/302 on POST) switch to GET.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
  throw new Error(`Exa search exceeded ${MAX_REDIRECTS} redirects`);
}

/** @param {number} status */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
