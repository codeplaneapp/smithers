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
 * The status feed is the whole point of the page, so it gets a short TTL: a
 * status edit lands within a minute of deploy instead of the 5 minutes the
 * shell HTML is happy with.
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
  if (pathname === "/status.json") return { ...FEED_HEADERS };
  if (pathname.startsWith("/assets/")) return { ...ASSET_HEADERS };
  return { ...HTML_HEADERS };
}

async function fetchAsset(request: Request, env: StatusSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  return withHeaders(response, headersFor(new URL(request.url).pathname));
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
          headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "status-site" });
      }

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      // A missing status feed must read as missing, not as an HTML page.
      if (url.pathname === "/status.json") return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createStatusSiteWorker();
