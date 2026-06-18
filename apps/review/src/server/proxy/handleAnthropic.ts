import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { authenticateProxyRequest } from "./authenticateProxyRequest.ts";
import { parseUsageFromJson } from "./parseUsageFromJson.ts";
import { parseUsageFromSse } from "./parseUsageFromSse.ts";
import { recordUsage } from "./recordUsage.ts";

export interface HandleAnthropicDeps {
  anthropicBaseUrl: string;
  fetchUpstream: typeof fetch;
  now: () => number;
  /**
   * Production: ctx.waitUntil from the Worker invocation, keeping the metering
   * write alive after the response stream closes. Tests pass a function that
   * pushes the promise to an array so the assertions can await it.
   */
  waitUntil: (promise: Promise<unknown>) => void;
}

const FORWARDED_HEADERS = new Set([
  "content-type",
  "accept",
  "accept-encoding",
  "anthropic-version",
  "anthropic-beta",
]);

function pickForwardHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of source.entries()) {
    if (FORWARDED_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function teeForMetering(
  upstream: Response,
): { passthrough: ReadableStream; collected: Promise<string> } {
  const [a, b] = upstream.body!.tee();
  const collected = (async () => {
    const reader = b.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      acc += decoder.decode();
    } catch {
      /* upstream closed unexpectedly; whatever we have is what we record */
    }
    return acc;
  })();
  return { passthrough: a, collected };
}

/**
 * /anthropic/v1/* — auth, forward to api.anthropic.com with the real key,
 * stream the response back unmodified, then meter from a teed copy. Anything
 * outside /v1/ is rejected: the proxy is not a general egress.
 */
export async function handleAnthropic(
  request: Request,
  env: ReviewWorkerEnv,
  deps: HandleAnthropicDeps,
  url: URL,
): Promise<Response> {
  const proxiedPath = url.pathname.slice("/anthropic".length);
  if (!proxiedPath.startsWith("/v1/")) {
    return jsonError(404, "only /v1/* paths are forwarded");
  }
  const now = deps.now();
  const auth = await authenticateProxyRequest(request, env, now);
  if (!auth) return jsonError(401, "unauthorized");

  let repo: string;
  let pr: number;
  let sessionHash: string | null = null;
  let spendCapUsd = Number.POSITIVE_INFINITY;
  let spentUsd = 0;
  if (auth.kind === "session") {
    repo = auth.repo;
    pr = auth.pr;
    sessionHash = auth.hash;
    spendCapUsd = auth.spendCapUsd;
    spentUsd = auth.spentUsd;
    if (spentUsd >= spendCapUsd) {
      return jsonError(402, "session spend cap exhausted", { spendCapUsd, spentUsd });
    }
  } else {
    repo = auth.repos[0] ?? auth.owner;
    pr = 0;
  }

  const upstreamUrl = `${deps.anthropicBaseUrl.replace(/\/$/, "")}${proxiedPath}${url.search}`;
  const upstreamHeaders = pickForwardHeaders(request.headers);
  upstreamHeaders.set("x-api-key", env.ANTHROPIC_API_KEY);
  upstreamHeaders.set("anthropic-version", upstreamHeaders.get("anthropic-version") ?? "2023-06-01");

  let upstreamBody: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    upstreamBody = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await deps.fetchUpstream(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: upstreamBody,
    });
  } catch (err) {
    return jsonError(502, "upstream fetch failed", { detail: String(err) });
  }

  if (!upstream.body) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const { passthrough, collected } = teeForMetering(upstream);

  const metering = (async () => {
    const body = await collected;
    const summary = contentType.includes("text/event-stream")
      ? parseUsageFromSse(body)
      : parseUsageFromJson(body);
    if (!summary) return;
    await recordUsage(env.DB, {
      sessionHash,
      repo,
      pr,
      summary,
      kind: contentType.includes("text/event-stream") ? "messages_stream" : "messages",
      now: deps.now(),
    });
  })().catch(() => undefined);
  deps.waitUntil(metering);

  const responseHeaders = new Headers();
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  return new Response(passthrough, { status: upstream.status, headers: responseHeaders });
}
