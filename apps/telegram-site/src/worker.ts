import { handleApprove } from "./handleApprove.ts";

export interface TelegramSiteEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  /** Bot token (Wrangler secret). Enables the reference /approve Mini App endpoint. */
  TELEGRAM_BOT_TOKEN?: string;
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

async function fetchAsset(request: Request, env: TelegramSiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status === 404) return response;
  const url = new URL(request.url);
  return withHeaders(response, url.pathname.startsWith("/assets/") ? ASSET_HEADERS : HTML_HEADERS);
}

async function fetchIndex(request: Request, env: TelegramSiteEnv): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return withHeaders(await env.ASSETS.fetch(new Request(url, request)), HTML_HEADERS);
}

export function createTelegramSiteWorker() {
  return {
    async fetch(request: Request, env: TelegramSiteEnv): Promise<Response> {
      const url = new URL(request.url);

      // Reference Mini App approval endpoint (verifies Telegram initData).
      if (url.pathname === "/approve") {
        if (request.method !== "POST") {
          return new Response("method not allowed", {
            status: 405,
            headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
          });
        }
        return handleApprove(request, env);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", {
          status: 405,
          headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, service: "telegram-site" });
      }

      const direct = await fetchAsset(request, env);
      if (direct.status !== 404) return direct;

      return fetchIndex(request, env);
    },
  };
}

export default createTelegramSiteWorker();
