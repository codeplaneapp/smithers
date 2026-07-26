export interface StorybookSiteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

// Storybook's manager and preview pages boot from inline scripts, and the
// preview renders inside a same-origin iframe, so script-src needs
// 'unsafe-inline' and framing must allow 'self'.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const HTML_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "public, max-age=300",
} as const;

const HASHED_ASSET_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "public, max-age=31536000, immutable",
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
  // Storybook writes content-hashed bundles under /assets/.
  if (pathname.startsWith("/assets/")) return HASHED_ASSET_HEADERS;
  return HTML_HEADERS;
}

async function fetchAsset(request: Request, env: StorybookSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  const url = new URL(request.url);
  return withHeaders(response, headersFor(url.pathname));
}

async function fetchIndex(request: Request, env: StorybookSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

export function createStorybookSiteWorker() {
  return {
    async fetch(request: Request, env: StorybookSiteEnv): Promise<Response> {
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
        return Response.json({ ok: true, service: "storybook-site" });
      }

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createStorybookSiteWorker();
