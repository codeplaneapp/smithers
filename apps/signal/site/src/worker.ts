interface MinimalKvNamespace {
  get(key: string): Promise<string | null>;
}

export interface SiteEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SIGNAL_REPORTS: MinimalKvNamespace;
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const next = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) next.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: next });
}

function json(body: unknown, status: number, cacheControl: string): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": cacheControl },
  });
}

async function handleApi(request: Request, env: SiteEnv, pathname: string): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  if (pathname === "/api/issue/latest") {
    // `latest` is a date pointer (spec: "## Cloudflare architecture (phase 2)"),
    // not the Issue JSON itself — resolve it to the dated report.
    const latestDate = await env.SIGNAL_REPORTS.get("latest");
    if (latestDate === null) return json({ error: "no issue has been published yet" }, 404, "no-store");
    const value = await env.SIGNAL_REPORTS.get(`report:${latestDate}`);
    if (value === null) return json({ error: "latest pointer is stale; report data is missing" }, 404, "no-store");
    return json(value, 200, "public, max-age=120");
  }

  if (pathname === "/api/archive") {
    const value = await env.SIGNAL_REPORTS.get("archive-index");
    return json(value ?? "[]", 200, "public, max-age=300");
  }

  const issueMatch = pathname.match(/^\/api\/issue\/(.+)$/);
  if (issueMatch) {
    const date = issueMatch[1]!;
    if (!DATE_PATTERN.test(date)) return json({ error: "invalid date; expected YYYY-MM-DD" }, 400, "no-store");
    const value = await env.SIGNAL_REPORTS.get(`report:${date}`);
    if (value === null) return json({ error: `no issue published for ${date}` }, 404, "no-store");
    return json(value, 200, "public, max-age=3600, immutable");
  }

  return null;
}

async function fetchIndex(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), {
    ...SECURITY_HEADERS,
    "cache-control": "public, max-age=60",
  });
}

export default {
  async fetch(request: Request, env: SiteEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (url.pathname === "/healthz") return json({ ok: true, service: "signal-site" }, 200, "no-store");

    const apiResponse = await handleApi(request, env, url.pathname);
    if (apiResponse) return apiResponse;
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, "no-store");

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404)
      return withHeaders(assetResponse, { ...SECURITY_HEADERS, "cache-control": "public, max-age=300" });

    return fetchIndex(request, env);
  },
};
