export interface FerricSiteEnv {
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

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const next = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) next.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  });
}

async function fetchAsset(request: Request, env: FerricSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  const url = new URL(request.url);
  return withHeaders(response, url.pathname.startsWith("/assets/") ? ASSET_HEADERS : HTML_HEADERS);
}

async function fetchPage(request: Request, env: FerricSiteEnv, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

/**
 * Extensionless routes for the pages this site ships. Asset lookup would 404 on
 * `/source` and the single-page fallback would then serve the overview page,
 * which is a wrong page rather than a missing one — so map them explicitly.
 */
const PAGES: Record<string, string> = {
  "/source": "/source.html",
  "/source/": "/source.html",
};

export function createFerricSiteWorker() {
  return {
    async fetch(request: Request, env: FerricSiteEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "ferric-site" });
      }

      const page = PAGES[url.pathname];
      if (page) return fetchPage(request, env, page);

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchPage(request, env, "/index.html");
    },
  };
}

export default createFerricSiteWorker();
