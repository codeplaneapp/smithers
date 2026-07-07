import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { openaiCompatible } from "@tanstack/ai-openai/compatible";
import { accountIdFromToken } from "./accountIdFromToken";
import { isAccessTokenExpired } from "./isAccessTokenExpired";
import {
  type ChatApi,
  resolveConciergeModelConfig,
} from "./resolveConciergeModelConfig";
import { type ChatMessage, type ValidationResult, validateChatBody } from "./validateChatBody";

const PORT = Number(process.env.SMITHERS_CONCIERGE_PORT ?? "5179");
const HOST = process.env.SMITHERS_CONCIERGE_HOST ?? "127.0.0.1";

/** OpenAI's API base (default upstream). */
const DEFAULT_CHAT_BASE_URL = "https://api.openai.com/v1";

/** Override with CHAT_API (e.g. "chat-completions" for a compat endpoint). */
const DEFAULT_CHAT_API = "responses";

/**
 * The ChatGPT-subscription backend only speaks Responses, so codex auth forces
 * it regardless of CHAT_API. API-key fallbacks honor CHAT_API.
 */
function resolveChatApi(usingSubscription: boolean, chatApiEnv: string | undefined): ChatApi {
  if (usingSubscription) return "responses";
  return (chatApiEnv ?? DEFAULT_CHAT_API) as ChatApi;
}

const DEFAULT_CHAT_SYSTEM_PROMPT =
  "You are Smithers, a helpful AI assistant. Answer clearly and concisely.";

/** ChatGPT-backed Responses endpoint base. The adapter appends `/responses`. */
const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ORIGINATOR = "codex_cli_rs";

type CodexSubscriptionCredential = {
  accessToken?: string;
  accountId?: string;
  refreshToken?: string;
};

type CodexResponsesAuth = {
  baseURL: string;
  token: string;
  headers: Record<string, string>;
};

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`codex token refresh failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!json.access_token) {
    throw new Error("codex token refresh returned no access_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
  };
}

let cachedCodexAuth: { accessToken: string; refreshToken: string } | null = null;

async function resolveCodexResponsesAuth(
  credential: CodexSubscriptionCredential | undefined,
): Promise<CodexResponsesAuth | null> {
  if (!credential) return null;
  const { accessToken: envAccessToken, refreshToken: envRefreshToken } = credential;
  const refreshToken = cachedCodexAuth?.refreshToken ?? envRefreshToken;

  let accessToken: string;
  if (cachedCodexAuth && !isAccessTokenExpired(cachedCodexAuth.accessToken)) {
    accessToken = cachedCodexAuth.accessToken;
  } else if (envAccessToken && !isAccessTokenExpired(envAccessToken)) {
    accessToken = envAccessToken;
  } else if (refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    cachedCodexAuth = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    };
    accessToken = refreshed.accessToken;
  } else if (envAccessToken) {
    throw new Error(
      "codex subscription access token is expired and no refresh token was " +
        "provided. Re-run `codex login` (or refresh ~/.codex/auth.json) so the " +
        "server has a valid ChatGPT-subscription token.",
    );
  } else {
    return null;
  }

  const accountId = credential.accountId ?? accountIdFromToken(accessToken);
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    session_id: crypto.randomUUID(),
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  return { baseURL: CODEX_RESPONSES_BASE_URL, token: accessToken, headers };
}

function codexCredentialFromEnv(env: {
  CODEX_ACCESS_TOKEN?: string;
  CODEX_ACCOUNT_ID?: string;
  CODEX_REFRESH_TOKEN?: string;
}): CodexSubscriptionCredential | undefined {
  const accessToken = env.CODEX_ACCESS_TOKEN?.trim() || undefined;
  const refreshToken = env.CODEX_REFRESH_TOKEN?.trim() || undefined;
  const accountId = env.CODEX_ACCOUNT_ID?.trim() || undefined;
  if (!accessToken && !refreshToken) return undefined;
  return { accessToken, accountId, refreshToken };
}

function streamChatResponse(opts: {
  baseURL: string;
  apiKey: string;
  api: ChatApi;
  model: string;
  effort: string;
  systemPrompt: string;
  messages: ChatMessage[];
  usingSubscription: boolean;
  defaultHeaders?: Record<string, string>;
}): Response {
  const openai = openaiCompatible({
    name: "openai",
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    models: [opts.model],
    api: opts.api,
    ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
  });
  // Reasoning shape differs by wire API: the Responses API takes a nested
  // `reasoning: { effort }`, while chat-completions takes a flat
  // `reasoning_effort`. effort "none" means "no reasoning param" — some
  // providers (Cerebras gpt-oss) 400 on `reasoning_effort: "none"` — so omit it.
  const reasoningOption =
    opts.effort && opts.effort !== "none"
      ? opts.api === "chat-completions"
        ? { reasoning_effort: opts.effort }
        : { reasoning: { effort: opts.effort } }
      : {};
  const stream = chat({
    adapter: openai(opts.model),
    messages: opts.messages,
    systemPrompts: [opts.systemPrompt],
    modelOptions: {
      ...reasoningOption,
      ...(opts.usingSubscription ? { store: false } : {}),
    },
  });
  return toServerSentEventsResponse(stream);
}

async function parseChatRequest(request: Request): Promise<ValidationResult> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }
  return validateChatBody(parsed);
}

/**
 * Whether an HTTP `Origin` authority names a loopback interface. Mirrors the
 * local gateway guard: a browser page at evil.com talking to 127.0.0.1 carries
 * the evil.com Origin, while the same-origin/proxied app carries loopback.
 */
function isLoopbackHost(hostHeader: string): boolean {
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon >= 0 && colon === host.indexOf(":") && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon);
    }
  }

  return (
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function rejectDisallowedBrowserOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin) {
    return isLoopbackOrigin(origin) ? null : new Response("Origin is not allowed", { status: 403 });
  }

  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return new Response("Origin is not allowed", { status: 403 });
  }
  return null;
}

/** The local gateway whose registered workflows the concierge can background. */
const GATEWAY_BASE = (process.env.SMITHERS_GATEWAY_PROXY_TARGET ?? "http://127.0.0.1:7331").replace(
  /\/+$/,
  "",
);

type WorkflowSummary = { key: string; readableName?: string; description?: string };

/** Pull the workflows registered on the gateway (best-effort, bounded). */
async function listGatewayWorkflows(): Promise<WorkflowSummary[]> {
  try {
    const res = await fetch(`${GATEWAY_BASE}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2500),
    });
    const frame = (await res.json()) as { ok?: boolean; payload?: unknown };
    return frame?.ok && Array.isArray(frame.payload) ? (frame.payload as WorkflowSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * The system prompt the model actually sees: the client's app-control prompt
 * (withAgentSystem) PLUS a live catalog of the workflows registered on the
 * gateway, so the agent knows exactly what it can background — including
 * `create-workflow`, the meta-workflow that builds a brand-new workflow. This is
 * the local equivalent of multi's worker knowing the workspace; without it the
 * model can't know which workflows exist (it would say "I can't create one").
 */
async function buildSystemPrompt(clientSystem: string | undefined): Promise<string> {
  const base = clientSystem ?? process.env.CHAT_SYSTEM_PROMPT ?? DEFAULT_CHAT_SYSTEM_PROMPT;
  const workflows = await listGatewayWorkflows();
  if (workflows.length === 0) return base;

  const list = workflows
    .map(
      (w) =>
        `- ${w.key}${w.readableName ? ` (${w.readableName})` : ""}${w.description ? `: ${w.description}` : ""}`,
    )
    .join("\n");
  const hasCreate = workflows.some((w) => w.key === "create-workflow");

  const catalog = [
    "",
    "## Smithers workflows on this gateway",
    'Background any of these for the user by ending your reply with a smithers:action block containing a `startWorkflow` directive: {"tool":"startWorkflow","args":{"workflowKey":"<key>","inputs":{"prompt":"<task>"}}}. This needs NO permission — do not emit requestControl for a workflow launch.',
    list,
    hasCreate
      ? '\nTo CREATE a brand-new Smithers workflow, background `create-workflow` with the user\'s description as the prompt — e.g. {"tool":"startWorkflow","args":{"workflowKey":"create-workflow","inputs":{"prompt":"<what they want the workflow to do>"}}}. It generates a new workflow for them.'
      : "",
    "When the user asks you to build, fix, review, research, plan, or create something, immediately background the best-matching workflow above rather than saying you can't.",
  ]
    .filter(Boolean)
    .join("\n");

  return `${base}\n${catalog}`;
}

async function handleChat(request: Request): Promise<Response> {
  const disallowedOrigin = rejectDisallowedBrowserOrigin(request);
  if (disallowedOrigin) return disallowedOrigin;

  const env = process.env;
  const codexCredential = codexCredentialFromEnv(env);
  const conciergeConfig = resolveConciergeModelConfig(env);
  if (conciergeConfig.provider !== "cerebras" && !codexCredential && !env.OPENAI_API_KEY) {
    return new Response(
      "Server is missing a chat credential (CEREBRAS_API_KEY, CODEX_ACCESS_TOKEN, or OPENAI_API_KEY)",
      { status: 500 },
    );
  }

  const validation = await parseChatRequest(request);
  if (!validation.ok) return new Response(validation.message, { status: validation.status });
  const body = validation.body;
  const systemPrompt = await buildSystemPrompt(body.system);

  if (conciergeConfig.provider === "cerebras") {
    return streamChatResponse({
      baseURL: conciergeConfig.baseURL,
      apiKey: conciergeConfig.apiKey,
      api: conciergeConfig.api,
      model: conciergeConfig.model,
      effort: conciergeConfig.effort,
      systemPrompt,
      messages: body.messages,
      usingSubscription: conciergeConfig.usingSubscription,
    });
  }

  let codexAuth: Awaited<ReturnType<typeof resolveCodexResponsesAuth>> = null;
  if (codexCredential) {
    try {
      codexAuth = await resolveCodexResponsesAuth(codexCredential);
    } catch (err) {
      return new Response(
        `Chat subscription credential unusable: ${err instanceof Error ? err.message : String(err)}`,
        { status: 502 },
      );
    }
  }

  const usingSubscription = codexAuth !== null;
  const baseURL = codexAuth?.baseURL ?? env.CHAT_BASE_URL ?? DEFAULT_CHAT_BASE_URL;
  const apiKey = codexAuth?.token ?? env.OPENAI_API_KEY ?? "";
  const api = resolveChatApi(usingSubscription, env.CHAT_API);

  return streamChatResponse({
    baseURL,
    apiKey,
    api,
    model: conciergeConfig.model,
    effort: conciergeConfig.effort,
    systemPrompt,
    messages: body.messages,
    usingSubscription,
    defaultHeaders: codexAuth?.headers,
  });
}

// Bind the server only when run as the entry (bun server.ts / bundled
// concierge.js). Importing this module for unit tests must NOT start a server —
// the pure request logic lives in the sibling `validateChatBody`,
// `resolveConciergeModelConfig`, and codex-token modules, which the tests import
// directly.
if (import.meta.main) {
  Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/chat") {
        return handleChat(request);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`[concierge] listening on http://${HOST}:${PORT}`);
}
