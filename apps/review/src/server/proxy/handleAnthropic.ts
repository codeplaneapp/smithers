import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { repoMonthlyCapUsd } from "../repoMonthlyCapUsd.ts";
import { repoMonthlySpendUsd } from "../repoMonthlySpendUsd.ts";
import { lookupRepo } from "../sessions/lookupRepo.ts";
import { anthropicEndpointAllowed } from "./anthropicEndpointAllowed.ts";
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

const FORWARDED_HEADERS = new Set(["content-type", "accept", "accept-encoding", "anthropic-version", "anthropic-beta"]);

// Clients need these to back off correctly and to reference upstream errors.
const PASSTHROUGH_RESPONSE_HEADERS = ["retry-after", "x-request-id"];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

type UpstreamResult =
  | { kind: "response"; response: Response }
  | { kind: "cross_origin_redirect"; location: string }
  | { kind: "too_many_redirects"; hops: number };

/**
 * fetch(redirect: "follow") replays the request headers — including the
 * injected x-api-key — to whatever host a Location header names; unlike
 * `authorization`, custom headers are NOT stripped on cross-origin redirects,
 * so a compromised or misconfigured upstream could bounce the proxy to an
 * attacker origin and exfiltrate the real Anthropic key. Follow redirects
 * manually instead: every hop must stay on the configured upstream origin,
 * so the key is only ever sent to that origin. A cross-origin Location is
 * never fetched at all (redirect: "manual" does not follow it).
 */
async function fetchUpstreamSameOrigin(
  fetchUpstream: typeof fetch,
  allowedOrigin: string,
  initial: { url: string; method: string; headers: Headers; body: ArrayBuffer | undefined },
): Promise<UpstreamResult> {
  let { url, method, body } = initial;
  const headers = initial.headers;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const response = await fetchUpstream(url, { method, headers, body, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { kind: "response", response };
    }
    void response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    if (next.origin !== allowedOrigin) {
      return { kind: "cross_origin_redirect", location: next.origin };
    }
    // Mirror fetch redirect semantics: 303 always re-issues as a bodyless GET,
    // as do 301/302 on POST; 307/308 replay the method and body unchanged.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }
    url = next.toString();
  }
  return { kind: "too_many_redirects", hops: MAX_REDIRECT_HOPS };
}

function pickForwardHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of source.entries()) {
    if (FORWARDED_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function teeForMetering(upstream: Response): { passthrough: ReadableStream; collected: Promise<string> } {
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
 * /anthropic/v1/messages — auth, forward to api.anthropic.com with the real
 * key, stream the response back unmodified, then meter from a teed copy. Only
 * the methods and paths in {@link anthropicEndpointAllowed} are forwarded: the
 * proxy is not a general egress, and the shared key it injects reaches every
 * object in the upstream workspace.
 */
export async function handleAnthropic(
  request: Request,
  env: ReviewWorkerEnv,
  deps: HandleAnthropicDeps,
  url: URL,
): Promise<Response> {
  const proxiedPath = url.pathname.slice("/anthropic".length);
  if (!anthropicEndpointAllowed(request.method, proxiedPath)) {
    return jsonError(404, "endpoint not forwarded; the proxy serves POST /v1/messages only", {
      method: request.method,
      path: proxiedPath,
    });
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
    // Re-read spent_usd at admission: concurrent streaming requests meter via
    // waitUntil after their streams close, so the row read during auth can be
    // stale. A fresh read narrows (not eliminates) the over-spend window
    // without a full reservation system.
    const fresh = await env.DB.prepare("SELECT spent_usd FROM sessions WHERE hash = ?")
      .bind(auth.hash)
      .first<{ spent_usd: number }>();
    spentUsd = fresh?.spent_usd ?? auth.spentUsd;
    if (spentUsd >= spendCapUsd) {
      return jsonError(402, "session spend cap exhausted", { spendCapUsd, spentUsd });
    }
    // The per-session cap above resets whenever a session is re-minted; the
    // per-repo month-to-date total does not. Enforce it so re-minted sessions
    // cannot drive unbounded spend on an already-reviewed PR. Skipped when the
    // repo has no live registration (nothing to derive a ceiling from).
    const registration = await lookupRepo(env.DB, repo);
    if (registration) {
      const monthlyCapUsd = repoMonthlyCapUsd(registration);
      const monthSpendUsd = await repoMonthlySpendUsd(env.DB, repo, now);
      if (monthSpendUsd >= monthlyCapUsd) {
        return jsonError(402, "repo monthly spend cap exhausted", {
          monthlyCapUsd,
          spentUsd: monthSpendUsd,
        });
      }
    }
  } else {
    const repoHint = request.headers.get("x-smithers-repo");
    // A key with no authorized repos cannot resolve to a repo at all. Honoring
    // an x-smithers-repo hint here would let such a key meter spend against ANY
    // repo's monthly budget (cross-tenant spend / DoS); falling back to
    // auth.owner would instead 403 forever on "repo not registered" (owner is
    // not a repo). Reject up front with an actionable message either way.
    if (auth.repos.length === 0) {
      return jsonError(403, "api key is not scoped to any repo; mint a repo-scoped key", {
        repo: repoHint ?? null,
      });
    }
    if (repoHint) {
      if (!auth.repos.includes(repoHint)) {
        return jsonError(403, "api key not authorized for repo", { repo: repoHint });
      }
      repo = repoHint;
    } else {
      repo = auth.repos[0];
    }
    pr = 0;

    const registration = await lookupRepo(env.DB, repo);
    if (!registration) {
      return jsonError(403, "repo not registered", { repo });
    }
    const monthlyCapUsd = repoMonthlyCapUsd(registration);
    const monthSpendUsd = await repoMonthlySpendUsd(env.DB, repo, now);
    if (monthSpendUsd >= monthlyCapUsd) {
      return jsonError(402, "repo monthly spend cap exhausted", {
        repo,
        month: new Date(now).toISOString().slice(0, 7),
        monthlyCapUsd,
        spentUsd: monthSpendUsd,
      });
    }
    if (auth.spendCapUsd != null && monthSpendUsd >= auth.spendCapUsd) {
      return jsonError(402, "api key spend cap exhausted", {
        repo,
        keyCapUsd: auth.spendCapUsd,
        spentUsd: monthSpendUsd,
      });
    }
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
    const result = await fetchUpstreamSameOrigin(deps.fetchUpstream, new URL(deps.anthropicBaseUrl).origin, {
      url: upstreamUrl,
      method: request.method,
      headers: upstreamHeaders,
      body: upstreamBody,
    });
    if (result.kind === "cross_origin_redirect") {
      // The injected key was NOT sent to (and never will be sent to) the
      // foreign origin; fail closed rather than forward credentials off-origin.
      return jsonError(502, "upstream redirected off the anthropic origin; refusing to forward credentials", {
        location: result.location,
      });
    }
    if (result.kind === "too_many_redirects") {
      return jsonError(502, "too many upstream redirects", { hops: result.hops });
    }
    upstream = result.response;
  } catch (err) {
    return jsonError(502, "upstream fetch failed", { detail: String(err) });
  }

  if (!upstream.body) {
    const text = await upstream.text();
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(text, { status: upstream.status, headers });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const { passthrough, collected } = teeForMetering(upstream);

  const metering = (async () => {
    const body = await collected;
    const summary = contentType.includes("text/event-stream") ? parseUsageFromSse(body) : parseUsageFromJson(body);
    if (!summary) {
      // A 2xx /v1/messages response that yields no usage is a metering MISS
      // (unexpected body shape), not a benign non-content frame — real spend
      // goes unrecorded. Surface it so Workers logs can catch a parser drift.
      if (upstream.status >= 200 && upstream.status < 300 && proxiedPath.startsWith("/v1/messages")) {
        console.error("smithers-review: metering miss (usage parser returned null on a 2xx messages response)", {
          repo,
          pr,
          path: proxiedPath,
          contentType,
        });
      }
      return;
    }
    await recordUsage(env.DB, {
      sessionHash,
      repo,
      pr,
      summary,
      kind: contentType.includes("text/event-stream") ? "messages_stream" : "messages",
      now: deps.now(),
    });
  })().catch((err) => {
    // recordUsage spends real money; a silent failure here is the last
    // unmetered-spend hole. Log (do not rethrow — the response already
    // streamed) so the drop is diagnosable in production.
    console.error("smithers-review: metering failed", {
      repo,
      pr,
      path: proxiedPath,
      status: upstream.status,
      err: String(err),
    });
  });
  deps.waitUntil(metering);

  const responseHeaders = new Headers();
  for (const h of ["content-type", "cache-control", ...PASSTHROUGH_RESPONSE_HEADERS]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  return new Response(passthrough, { status: upstream.status, headers: responseHeaders });
}
