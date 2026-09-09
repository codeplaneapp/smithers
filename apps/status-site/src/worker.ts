export interface StatusSiteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const HTML_HEADERS = {
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
} as const;

const ASSET_HEADERS = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
} as const;

/**
 * The page uses cache: "no-cache" to revalidate on every load. Other clients
 * may reuse the feed for 60 seconds before revalidating with its validators.
 */
const FEED_HEADERS = {
  "cache-control": "public, max-age=60, must-revalidate",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
} as const;

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const next = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) next.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  });
}

function headersFor(pathname: string): Record<string, string> {
  if (pathname.startsWith("/assets/")) return { ...ASSET_HEADERS };
  return { ...HTML_HEADERS };
}

async function fetchAsset(request: Request, env: StatusSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  return withHeaders(response, headersFor(new URL(request.url).pathname));
}

/**
 * The assets binding runs with `not_found_handling: single-page-application`,
 * so a missing status.json comes back as the index page with a 200 rather than
 * a 404. Handing that to a caller would be HTML claiming to be the feed, so
 * anything that is not JSON is reported as a missing feed instead.
 */
async function fetchFeed(request: Request, env: StatusSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 304) return withHeaders(response, FEED_HEADERS);
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.includes("json")) {
    const reason = response.status === 404 ? "missing" : response.status === 200 ? "not-json" : "unexpected-status";
    console.warn("status feed refused", {
      status: response.status,
      contentType,
      pathname: new URL(request.url).pathname,
    });
    return withHeaders(
      Response.json({ error: "status feed unavailable", reason }, { status: 404 }),
      { ...FEED_HEADERS, "cache-control": "no-store" },
    );
  }
  return withHeaders(response, FEED_HEADERS);
}

async function fetchIndex(request: Request, env: StatusSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

export function createStatusSiteWorker() {
  return {
    async fetch(request: Request, env: StatusSiteEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: {
            allow: "GET, HEAD",
            "content-type": "text/plain; charset=utf-8",
            ...(url.pathname === "/status.json" ? { ...FEED_HEADERS, "cache-control": "no-store" } : {}),
          },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "status-site" });
      }

      // A missing status feed must read as missing, not as an HTML page.
      if (url.pathname === "/status.json") return fetchFeed(request, env);

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createStatusSiteWorker();
