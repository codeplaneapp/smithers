import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import type { CloudflareEnv } from "./env";
import { error as logError, redactHeaders, redactUrl } from "./observability/logger";
import { workerRegistry } from "./observability/metrics";
import { renderPrometheus } from "./observability/promExposition";
import {
  proxyAuthFailuresTotal,
  proxyDurationMs,
  proxyOutcomeFor,
  proxyPayloadBytes,
  proxyRequestsTotal,
  proxyRouteKindFor,
  type ProxyRouteKind,
} from "./observability/uiMetrics";

/** Cerebras' OpenAI-compatible Chat Completions endpoint (default upstream). */
const DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

/** The Cerebras model the chat runs on. */
const DEFAULT_CEREBRAS_MODEL = "zai-glm-4.7";

/** Most messages we will forward to Cerebras in a single request. */
const MAX_MESSAGES = 100;

/** Cap on the summed byte length of all message content (~100KB). */
const MAX_CONTENT_BYTES = 100 * 1024;

/** Cap on the client-supplied system prompt (~4KB); longer ones are truncated. */
const MAX_SYSTEM_BYTES = 4 * 1024;

type ChatMessage = { role: "user" | "assistant"; content: string };

type ChatBody = {
  messages: Array<ChatMessage>;
  /** Optional system prompt prepended to the conversation. */
  system?: string;
};

type AuthenticatedProxyUser = {
  id: string;
  username: string;
  isAdmin: boolean;
};

type AuthValidation =
  | { ok: true; user: AuthenticatedProxyUser }
  | { ok: false; status: number; message: string };

const encoder = new TextEncoder();

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const TRUSTED_PROXY_HEADERS = [
  "x-user-id",
  "x-user-scopes",
  "x-user-role",
  "x-smithers-token-id",
];

const GATEWAY_CREDENTIAL_HEADERS = ["authorization", "x-smithers-key"];

const DEFAULT_GATEWAY_SCOPES = [
  "run:read",
  "run:write",
  "approval:submit",
  "signal:submit",
  "cron:read",
  "cron:write",
  "observability:read",
];

function isChatMessage(value: unknown): value is ChatMessage {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  );
}

type ValidationResult =
  | { ok: true; body: ChatBody }
  | { ok: false; status: number; message: string };

/**
 * Validate the parsed request body without trusting any field. A valid-JSON
 * `null`/number/array yields a clean 400 rather than a thrown 500. Enforces the
 * message-count, content-size, and system-prompt caps before the key is touched.
 */
function validateChatBody(parsed: unknown): ValidationResult {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: "Request body must be a JSON object" };
  }
  const candidate = parsed as Record<string, unknown>;

  if (!Array.isArray(candidate.messages)) {
    return { ok: false, status: 400, message: "Request body must include messages[]" };
  }
  if (candidate.messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      status: 413,
      message: `Too many messages (max ${MAX_MESSAGES})`,
    };
  }

  let contentBytes = 0;
  for (const message of candidate.messages) {
    if (!isChatMessage(message)) {
      return {
        ok: false,
        status: 400,
        message:
          'Each message must have role "user" or "assistant" and string content',
      };
    }
    contentBytes += encoder.encode(message.content).length;
    if (contentBytes > MAX_CONTENT_BYTES) {
      return {
        ok: false,
        status: 413,
        message: `Message content too large (max ${MAX_CONTENT_BYTES} bytes)`,
      };
    }
  }

  let system: string | undefined;
  if (candidate.system !== undefined) {
    if (typeof candidate.system !== "string") {
      return { ok: false, status: 400, message: "system must be a string" };
    }
    // Bound the client-supplied prompt by bytes so it cannot be abused, then
    // decode back to a string (slicing on a byte boundary is fine: any partial
    // trailing UTF-8 sequence is dropped by the lossy decoder).
    const encoded = encoder.encode(candidate.system);
    system =
      encoded.length > MAX_SYSTEM_BYTES
        ? new TextDecoder().decode(encoded.slice(0, MAX_SYSTEM_BYTES))
        : candidate.system;
  }

  return {
    ok: true,
    body: { messages: candidate.messages as ChatMessage[], system },
  };
}

function envUrl(value: string | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url;
  } catch {
    return null;
  }
}

function authBaseUrl(env: CloudflareEnv): URL | null {
  return envUrl(env.AUTH_API_BASE_URL ?? env.PLUE_API_BASE_URL);
}

function gatewayBaseUrl(env: CloudflareEnv): URL | null {
  return envUrl(env.GATEWAY_BASE_URL);
}

function platformBaseUrl(env: CloudflareEnv): URL | null {
  return envUrl(env.GO_API_BASE_URL ?? env.AUTH_API_BASE_URL ?? env.PLUE_API_BASE_URL);
}

function authCallbackBaseUrl(request: Request, env: CloudflareEnv): URL {
  return envUrl(env.AUTH_CALLBACK_BASE_URL) ?? new URL(new URL(request.url).origin);
}

function joinedTargetUrl(base: URL, pathname: string, search = ""): URL {
  const target = new URL(base.toString());
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  target.search = search;
  target.hash = "";
  return target;
}

function proxyTargetUrl(request: Request, base: URL): URL {
  const source = new URL(request.url);
  return joinedTargetUrl(base, source.pathname, source.search);
}

/**
 * jjhub (Plue) puts the signed-in user's own repos, workspaces, orgs, starred,
 * readable-repos, etc. under `/api/user/<sub>`. Identity itself stays at
 * `/api/user` (exact). These subpaths must route to the platform base (jjhub),
 * not the auth base, when auth and Plue are split. In the monolith case the
 * platform base falls back to auth, so the same dispatch keeps working.
 *
 * Adding a new subpath here is intentionally cheap: the set is small and
 * easy to audit. Anything not listed stays on the auth proxy (e.g. account
 * settings, tokens).
 */
const PLATFORM_USER_SUBPATHS = [
  "/api/user/repos",
  "/api/user/readable-repos",
  "/api/user/workspaces",
  "/api/user/orgs",
  "/api/user/starred",
  "/api/user/issues",
  "/api/user/landings",
  "/api/user/notifications",
  "/api/user/subscriptions",
  "/api/user/following",
  "/api/user/followers",
  "/api/user/searches",
];

function isPlatformUserSubpath(pathname: string): boolean {
  if (!pathname.startsWith("/api/user/")) return false;
  for (const prefix of PLATFORM_USER_SUBPATHS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function isAuthProxyRoute(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/user") return true;
  if (pathname.startsWith("/api/user/")) return !isPlatformUserSubpath(pathname);
  return false;
}

function isGatewayProxyRoute(pathname: string): boolean {
  return pathname === "/health" ||
    pathname.startsWith("/v1/rpc") ||
    // The Electric write endpoint is a gateway HTTP route (writes always flow
    // through the gateway/RPC path, never through shapes — design §5.5), so it
    // is forwarded to the same gateway upstream as /v1/rpc. The Electric READ
    // shapes (/v1/shape) are a SEPARATE cloud service fronted by
    // smithers-electric-proxy at its own URL, never same-origin.
    pathname.startsWith("/v1/electric/write") ||
    pathname.startsWith("/workflows");
}

/**
 * jjhub (Plue) code-hosting REST routes that are NOT under `/api/user/*`.
 * `/api/user/<sub>` is handled separately via `isPlatformUserSubpath` so it can
 * override the auth proxy when auth and Plue are split.
 *
 * Credentials forward straight through; jjhub validates the session itself.
 */
function isPlatformProxyRoute(pathname: string): boolean {
  return (
    pathname === "/api/repos" ||
    pathname.startsWith("/api/repos/") ||
    pathname === "/api/orgs" ||
    pathname.startsWith("/api/orgs/") ||
    pathname === "/api/search" ||
    pathname.startsWith("/api/search/") ||
    pathname === "/api/notifications" ||
    pathname.startsWith("/api/notifications/") ||
    pathname === "/api/issues" ||
    pathname.startsWith("/api/issues/") ||
    pathname === "/api/landings" ||
    pathname.startsWith("/api/landings/") ||
    pathname === "/api/workspaces" ||
    pathname.startsWith("/api/workspaces/") ||
    pathname.startsWith("/api/integrations/") ||
    pathname.startsWith("/api/oauth2/") ||
    pathname.startsWith("/resolve/")
  );
}

function proxyHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
  // Defense-in-depth: drop any client-supplied trusted-proxy headers on every
  // upstream call. The gateway path re-adds them inside `proxyGatewayRequest`
  // *after* validating the session — every other upstream (auth, platform,
  // chat) authenticates independently and should never see attacker-supplied
  // `x-user-*` / `x-smithers-token-id` values.
  stripTrustedProxyHeaders(headers);
  const source = new URL(request.url);
  headers.set("x-forwarded-host", source.host);
  headers.set("x-forwarded-proto", source.protocol.replace(":", ""));
  return headers;
}

function stripTrustedProxyHeaders(headers: Headers): void {
  for (const name of TRUSTED_PROXY_HEADERS) {
    headers.delete(name);
  }
}

function stripGatewayCredentialHeaders(headers: Headers): void {
  for (const name of GATEWAY_CREDENTIAL_HEADERS) {
    headers.delete(name);
  }
}

function gatewayAuthToken(env: CloudflareEnv): string | null {
  const token = env.GATEWAY_AUTH_TOKEN?.trim();
  if (!token) return null;
  return token.replace(/^(bearer|token)\s+/i, "").trim() || null;
}

function addGatewayCredential(headers: Headers, token: string): void {
  stripGatewayCredentialHeaders(headers);
  headers.set("authorization", `Bearer ${token}`);
}

function rewriteProxyLocation(headers: Headers, request: Request, upstreamBase: URL): void {
  const location = headers.get("location");
  if (!location) return;
  let upstreamLocation: URL;
  try {
    upstreamLocation = new URL(location, upstreamBase);
  } catch {
    return;
  }
  if (upstreamLocation.origin !== upstreamBase.origin) return;

  const basePath = upstreamBase.pathname.replace(/\/+$/, "");
  let pathname = upstreamLocation.pathname;
  if (basePath && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  }
  const requestOrigin = new URL(request.url).origin;
  const rewritten = new URL(`${pathname}${upstreamLocation.search}${upstreamLocation.hash}`, requestOrigin);
  headers.set("location", rewritten.toString());
}

function authCallbackPath(pathname: string): string | null {
  if (pathname === "/api/auth/workos/authorize") return "/api/auth/workos/callback";
  if (pathname === "/api/auth/auth0/authorize") return "/api/auth/auth0/callback";
  if (pathname === "/api/auth/github") return "/api/auth/github/callback";
  return null;
}

function rewriteOAuthRedirectUri(headers: Headers, request: Request, env: CloudflareEnv): void {
  const callbackPath = authCallbackPath(new URL(request.url).pathname);
  if (!callbackPath) return;
  const location = headers.get("location");
  if (!location) return;
  let authorizeUrl: URL;
  try {
    authorizeUrl = new URL(location);
  } catch {
    return;
  }
  if (!authorizeUrl.searchParams.has("redirect_uri")) return;
  const callback = new URL(callbackPath, authCallbackBaseUrl(request, env));
  authorizeUrl.searchParams.set("redirect_uri", callback.toString());
  headers.set("location", authorizeUrl.toString());
}

async function proxyWithHeaders(request: Request, base: URL, headers: Headers): Promise<Response> {
  const target = proxyTargetUrl(request, base);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  const response = await fetch(target.toString(), init);
  const responseHeaders = new Headers(response.headers);
  rewriteProxyLocation(responseHeaders, request, base);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

function proxyRequest(request: Request, base: URL): Promise<Response> {
  return proxyWithHeaders(request, base, proxyHeaders(request));
}

// --- Smithers Pair (multiplayer POC) ---------------------------------------
// Reverse-proxies the realtime `/sync/*` API to the Pair backend (a Freestyle
// sandbox running the ElectricSQL shape server + Codex), gated by an access key
// carried as a `pair_key` cookie so the SPA needs no key handling of its own.

function pairKeys(env: CloudflareEnv): string[] {
  return (env.PAIR_KEYS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
function pairCookieValue(request: Request): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "pair_key") return decodeURIComponent(rest.join("="));
  }
  return null;
}
function validPairKey(key: string | null | undefined, env: CloudflareEnv): boolean {
  return !!key && pairKeys(env).includes(key);
}
/** A valid `?key=…` sets the cookie and lands on /pair. Invalid/absent: fall through. */
function pairKeyRedirect(request: Request, env: CloudflareEnv): Response | null {
  const provided = new URL(request.url).searchParams.get("key");
  if (provided === null || pairKeys(env).length === 0 || !validPairKey(provided, env)) return null;
  return new Response(null, {
    status: 302,
    headers: {
      location: "/pair",
      "set-cookie": `pair_key=${encodeURIComponent(provided)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    },
  });
}
function isPairSyncRoute(pathname: string): boolean {
  return pathname === "/sync" || pathname.startsWith("/sync/");
}
async function proxyPairSync(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!env.PAIR_SYNC) return new Response("Pair sync not configured", { status: 404 });
  const key = pairCookieValue(request) ?? request.headers.get("x-pair-key");
  if (!validPairKey(key, env)) {
    return new Response(JSON.stringify({ message: "access key required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  // One shared room → one Durable Object instance (the stable, always-on sync
  // backend). The DO calls Codex in the Freestyle sandbox on demand.
  const id = env.PAIR_SYNC.idFromName("default-room");
  return env.PAIR_SYNC.get(id).fetch(request);
}

async function proxyAuthRequest(request: Request, env: CloudflareEnv, base: URL): Promise<Response> {
  const response = await proxyWithHeaders(request, base, proxyHeaders(request));
  const headers = new Headers(response.headers);
  rewriteOAuthRedirectUri(headers, request, env);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseAuthenticatedUser(payload: unknown): AuthenticatedProxyUser | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const id = record.id;
  const username = record.username;
  if ((typeof id !== "string" && typeof id !== "number") || typeof username !== "string") {
    return null;
  }
  return {
    id: String(id),
    username,
    isAdmin: record.is_admin === true,
  };
}

async function validateAuth(request: Request, base: URL): Promise<AuthValidation> {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const origin = request.headers.get("origin");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  if (origin) headers.set("origin", origin);
  headers.set("accept", "application/json");

  let response: Response;
  try {
    response = await fetch(joinedTargetUrl(base, "/api/user").toString(), {
      method: "GET",
      headers,
      redirect: "manual",
    });
  } catch {
    return { ok: false, status: 502, message: "Authentication service unavailable" };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: response.status === 403 ? "Forbidden" : "Authentication required",
    };
  }

  const user = parseAuthenticatedUser(await response.json().catch(() => null));
  if (!user) {
    return { ok: false, status: 401, message: "Auth response did not include a user." };
  }
  return { ok: true, user };
}

function gatewayScopesFor(user: AuthenticatedProxyUser, env: CloudflareEnv): string {
  const configured = env.GATEWAY_TRUSTED_PROXY_SCOPES?.trim();
  if (configured) {
    return configured
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
      .join(" ");
  }
  return (user.isAdmin ? ["run:admin", ...DEFAULT_GATEWAY_SCOPES] : DEFAULT_GATEWAY_SCOPES).join(" ");
}

function addTrustedProxyHeaders(headers: Headers, user: AuthenticatedProxyUser, env: CloudflareEnv): void {
  headers.set("x-user-id", user.id);
  headers.set("x-user-role", env.GATEWAY_TRUSTED_PROXY_ROLE?.trim() || (user.isAdmin ? "admin" : "operator"));
  headers.set("x-user-scopes", gatewayScopesFor(user, env));
  headers.set("x-smithers-token-id", `plue:${user.id}`);
}

function gatewayAuthFailure(pathname: string, validation: AuthValidation): Response {
  const status = validation.ok ? 401 : validation.status || 401;
  const message = validation.ok ? "Authentication required" : validation.message;
  if (pathname.startsWith("/v1/rpc")) {
    return new Response(
      JSON.stringify({
        type: "res",
        apiVersion: "v1",
        ok: false,
        error: { code: status === 403 ? "FORBIDDEN" : "UNAUTHORIZED", message },
      }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new Response(message, { status });
}

async function proxyGatewayRequest(request: Request, env: CloudflareEnv, base: URL): Promise<Response> {
  const headers = proxyHeaders(request);
  stripTrustedProxyHeaders(headers);
  stripGatewayCredentialHeaders(headers);

  const token = gatewayAuthToken(env);
  if (token) {
    addGatewayCredential(headers, token);
    return proxyWithHeaders(request, base, headers);
  }

  const authBase = authBaseUrl(env);
  if (!authBase) {
    return gatewayAuthFailure(new URL(request.url).pathname, {
      ok: false,
      status: 401,
      message: "Gateway authentication service is not configured",
    });
  }
  const validation = await validateAuth(request, authBase);
  if (!validation.ok) {
    return gatewayAuthFailure(new URL(request.url).pathname, validation);
  }
  addTrustedProxyHeaders(headers, validation.user, env);

  return proxyWithHeaders(request, base, headers);
}

function chatAuthRequired(env: CloudflareEnv): boolean {
  const value = env.AUTH_REQUIRED?.trim().toLowerCase();
  if (value === "false" || value === "0" || value === "no") return false;
  if (value === "true" || value === "1" || value === "yes") return true;
  return authBaseUrl(env) !== null;
}

async function requireChatAuth(request: Request, env: CloudflareEnv): Promise<Response | null> {
  if (!chatAuthRequired(env)) return null;
  const base = authBaseUrl(env);
  if (!base) {
    return new Response("Server is missing AUTH_API_BASE_URL", { status: 500 });
  }
  const validation = await validateAuth(request, base);
  if (!validation.ok) {
    return new Response(validation.message, { status: validation.status });
  }
  return null;
}

/**
 * POST /api/chat — runs the Cerebras chat on the server via TanStack AI and
 * streams the reply back as Server-Sent Events. The Cerebras key is a Worker
 * secret, so it never reaches the browser.
 */
async function handleChat(request: Request, env: CloudflareEnv): Promise<Response> {
  if (!env.CEREBRAS_API_KEY) {
    return new Response("Server is missing CEREBRAS_API_KEY", { status: 500 });
  }

  // Origin check: require a same-origin Origin header. This blocks cross-site
  // browser abuse and naive no-Origin curl. A determined attacker can forge the
  // header, so this is not a true rate limit; pair it with a Cloudflare Rate
  // Limiting rule for real per-IP limiting (intentionally no infra binding here).
  const origin = request.headers.get("Origin");
  if (origin === null || origin !== new URL(request.url).origin) {
    return new Response("Forbidden: cross-origin request", { status: 403 });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const validation = validateChatBody(parsed);
  if (!validation.ok) {
    return new Response(validation.message, { status: validation.status });
  }
  const body = validation.body;

  const baseURL = env.CEREBRAS_BASE_URL ?? DEFAULT_CEREBRAS_BASE_URL;
  const model = env.CEREBRAS_MODEL ?? DEFAULT_CEREBRAS_MODEL;
  const cerebras = openaiCompatible({
    name: "cerebras",
    baseURL,
    apiKey: env.CEREBRAS_API_KEY,
    models: [model],
  });

  const stream = chat({
    adapter: cerebras(model),
    messages: body.messages,
    systemPrompts: body.system ? [body.system] : undefined,
  });

  return toServerSentEventsResponse(stream);
}

function payloadBytes(request: Request): number {
  const header = request.headers.get("content-length");
  if (!header) return 0;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function recordProxyRequest(
  routeKind: ProxyRouteKind,
  method: string,
  status: number,
  durationMs: number,
  bytes: number,
): void {
  const outcome = proxyOutcomeFor(status);
  proxyRequestsTotal.inc({ route_kind: routeKind, method, outcome });
  proxyDurationMs.observe(durationMs, { route_kind: routeKind, method });
  if (bytes > 0) {
    proxyPayloadBytes.observe(bytes, { route_kind: routeKind });
  }
  if (outcome === "auth_failure") {
    proxyAuthFailuresTotal.inc({
      route_kind: routeKind,
      reason: status === 401 ? "unauthorized" : "forbidden",
    });
  }
}

async function handleMetrics(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  // Same-origin guard for the browser. Tools that scrape via curl with no
  // Origin header are allowed through; cross-origin browser requests are not.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response("Forbidden: cross-origin metrics scrape", { status: 403 });
  }
  const body = renderPrometheus(workerRegistry);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}

async function routeRequest(
  request: Request,
  env: CloudflareEnv,
  url: URL,
): Promise<Response> {
  const authBase = authBaseUrl(env);
  const gatewayBase = gatewayBaseUrl(env);

  // A keyed Pair link (`/?key=…`) sets the access cookie and redirects to /pair.
  const pairRedirect = pairKeyRedirect(request, env);
  if (pairRedirect) return pairRedirect;

  if (url.pathname === "/metrics") {
    return handleMetrics(request);
  }

  // Platform user subpaths (`/api/user/repos`, `/api/user/workspaces`, …) win
  // over the auth proxy so the split-config case (auth ≠ jjhub) routes them to
  // jjhub. In the monolith case `platformBase` falls back to `authBase` so
  // the same dispatch lands on the right server with no extra branching.
  if (isPlatformUserSubpath(url.pathname)) {
    const platformBase = platformBaseUrl(env);
    if (!platformBase) {
      return new Response("Platform API not configured", { status: 404 });
    }
    return proxyRequest(request, platformBase);
  }

  if (isAuthProxyRoute(url.pathname) && authBase) {
    return proxyAuthRequest(request, env, authBase);
  }

  if (isPlatformProxyRoute(url.pathname)) {
    const platformBase = platformBaseUrl(env);
    if (!platformBase) {
      return new Response("Platform API not configured", { status: 404 });
    }
    return proxyRequest(request, platformBase);
  }

  if (isGatewayProxyRoute(url.pathname)) {
    if (!gatewayBase) {
      return new Response("Gateway not configured", { status: 404 });
    }
    return proxyGatewayRequest(request, env, gatewayBase);
  }

  if (url.pathname === "/api/chat") {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const authFailure = await requireChatAuth(request, env);
    if (authFailure) {
      return authFailure;
    }
    return handleChat(request, env);
  }

  // Smithers Pair realtime API → Freestyle backend (gated by access key).
  if (isPairSyncRoute(url.pathname)) {
    return proxyPairSync(request, env);
  }

  // Static assets (and the SPA fallback) are served by the platform before a
  // request reaches the Worker. Anything else that lands here is handed to the
  // assets binding when present, otherwise it's a genuine 404.
  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: CloudflareEnv): Promise<Response> {
    const url = new URL(request.url);
    const startMs = nowMs();
    const routeKind = proxyRouteKindFor(url.pathname);
    const method = request.method;
    const bytes = payloadBytes(request);
    let response: Response;
    try {
      response = await routeRequest(request, env, url);
    } catch (err) {
      logError(
        "worker.unhandled",
        {
          url: redactUrl(request.url),
          method,
          headers: redactHeaders(request.headers),
          reason: err instanceof Error ? err.message : String(err ?? ""),
        },
        "worker",
      );
      response = new Response("Internal Server Error", { status: 500 });
    }
    recordProxyRequest(routeKind, method, response.status, nowMs() - startMs, bytes);
    if (response.status >= 500) {
      logError(
        "worker.upstream-error",
        {
          url: redactUrl(request.url),
          method,
          status: response.status,
          route_kind: routeKind,
        },
        "worker",
      );
    }
    return response;
  },
};

export { PairSync } from "./pair/pairSyncDO";
export type { ProxyRouteKind };
