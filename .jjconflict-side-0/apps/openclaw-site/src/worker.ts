export interface OpenClawSiteEnv {
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

async function fetchAsset(request: Request, env: OpenClawSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  const url = new URL(request.url);
  return withHeaders(response, url.pathname.startsWith("/assets/") ? ASSET_HEADERS : HTML_HEADERS);
}

async function fetchIndex(request: Request, env: OpenClawSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

export function createOpenClawSiteWorker() {
  return {
    async fetch(request: Request, env: OpenClawSiteEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "openclaw-site" });
      }

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createOpenClawSiteWorker();
