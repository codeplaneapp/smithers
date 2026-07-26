export interface KimiBenchmarksSiteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const HTML_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "public, max-age=300",
} as const;

const ARTIFACT_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "public, max-age=3600",
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

async function fetchAsset(request: Request, env: KimiBenchmarksSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  const url = new URL(request.url);
  return withHeaders(response, url.pathname.startsWith("/evidence/") ? ARTIFACT_HEADERS : HTML_HEADERS);
}

async function fetchIndex(request: Request, env: KimiBenchmarksSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

export function createKimiBenchmarksSiteWorker() {
  return {
    async fetch(request: Request, env: KimiBenchmarksSiteEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: {
            allow: "GET, HEAD",
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "kimi-benchmarks-site" });
      }

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createKimiBenchmarksSiteWorker();
