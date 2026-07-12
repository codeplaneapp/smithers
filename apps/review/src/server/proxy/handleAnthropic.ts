import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { repoMonthlyCapUsd } from "../repoMonthlyCapUsd.ts";
import { repoMonthlySpendUsd } from "../repoMonthlySpendUsd.ts";
import { lookupRepo } from "../sessions/lookupRepo.ts";
import { authenticateProxyRequest } from "./authenticateProxyRequest.ts";
import { parseUsageFromJson } from "./parseUsageFromJson.ts";
import { parseUsageFromSse } from "./parseUsageFromSse.ts";
import { recordUsage } from "./recordUsage.ts";
import {
  estimateMessagesSpend,
  prepareMessagesRequest,
  releaseSpendReservation,
  reserveSpend,
  type SpendReservation,
} from "./spendReservations.ts";
import {
  assertHttpUrl,
  fetchWithPolicy,
  HttpClientPolicyError,
  isHttpClientPolicyError,
  readResponseBytes,
  readResponseJson,
} from "@smithers-orchestrator/http-client";

export interface HandleAnthropicDeps {
  anthropicBaseUrl: string;
  fetchUpstream: typeof fetch;
  /** Additional origins authorized to receive the upstream Anthropic key on redirects. */
  anthropicAllowedOrigins?: string[];
  /** Maximum request body forwarded upstream. Defaults to 16 MiB. */
  anthropicMaxRequestBytes?: number;
  /** Maximum response data retained for usage metering. Defaults to 16 MiB. */
  anthropicMaxMeteringBytes?: number;
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

// Clients need these to back off correctly and to reference upstream errors.
const PASSTHROUGH_RESPONSE_HEADERS = ["retry-after", "x-request-id"];
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_METERING_BYTES = 16 * 1024 * 1024;
const MAX_TOKEN_COUNT_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_PROXY_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

function anthropicRedirectValidator(baseUrl: URL, allowedOrigins: string[] | undefined) {
  const authorized = new Set([baseUrl.origin]);
  for (const entry of allowedOrigins ?? []) {
    authorized.add(assertHttpUrl(entry).origin);
  }
  return (candidate: URL, context: { initial: boolean; from?: URL }) => {
    if (context.initial || authorized.has(candidate.origin)) return;
    throw new HttpClientPolicyError(
      "INVALID_REDIRECT",
      "Anthropic upstream returned a cross-origin redirect; refusing to forward credentials.",
      { fromOrigin: context.from?.origin, toOrigin: candidate.origin },
    );
  };
}

function validByteLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function pickForwardHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of source.entries()) {
    if (FORWARDED_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

function cancelResponseBodyBestEffort(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => undefined);
  } catch {
    // A custom transport may throw synchronously. Cleanup must not replace the
    // primary provider status or prevent a reservation decision from settling.
  }
}

async function countProviderInputTokens(input: {
  url: URL;
  headers: Headers;
  body: ArrayBuffer;
  signal: AbortSignal;
  fetchUpstream: typeof fetch;
  allowedOrigins?: string[];
}): Promise<number> {
  const validateUrl = anthropicRedirectValidator(input.url, input.allowedOrigins);
  const response = await fetchWithPolicy(input.url, {
    method: "POST",
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  }, {
    fetch: input.fetchUpstream,
    allowedOrigins: input.allowedOrigins,
    validateUrl,
  });
  if (!response.ok) {
    cancelResponseBodyBestEffort(response);
    throw new Error(`Anthropic token counting responded ${response.status}`);
  }
  const payload = await readResponseJson<{ input_tokens?: unknown }>(response, {
    maxBytes: MAX_TOKEN_COUNT_RESPONSE_BYTES,
    signal: input.signal,
  });
  if (
    !Number.isSafeInteger(payload?.input_tokens)
    || (payload.input_tokens as number) < 0
  ) {
    throw new Error("Anthropic token counting returned an invalid input_tokens value");
  }
  return payload.input_tokens as number;
}

type CollectedMeteringBody = {
  text: string;
  truncated: boolean;
  complete: boolean;
};

/**
 * Collect a bounded view of the response while the other tee branch streams
 * to the caller. For oversized SSE responses we retain both ends: Anthropic's
 * message_start usage is near the beginning and message_delta usage is near
 * the end. This keeps metering useful without retaining arbitrary model output
 * in Worker memory.
 */
function streamForMetering(
  upstream: Response,
  maxBytes: number,
): { passthrough: ReadableStream; collected: Promise<CollectedMeteringBody> } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Anthropic metering byte limit must be a non-negative safe integer");
  }
  const reader = upstream.body!.getReader();
  const headLimit = Math.ceil(maxBytes / 2);
  const tailLimit = Math.floor(maxBytes / 2);
  const head = new Uint8Array(headLimit);
  const tail = new Uint8Array(tailLimit);
  let headLength = 0;
  let tailLength = 0;
  let tailOffset = 0;
  let totalBytes = 0;
  let settled = false;
  let cancelled = false;
  let resolveCollected!: (value: CollectedMeteringBody) => void;
  const collected = new Promise<CollectedMeteringBody>((resolve) => {
    resolveCollected = resolve;
  });

  const appendTail = (chunk: Uint8Array) => {
    if (tailLimit === 0) return;
    if (chunk.byteLength >= tailLimit) {
      tail.set(chunk.subarray(chunk.byteLength - tailLimit));
      tailLength = tailLimit;
      tailOffset = 0;
      return;
    }
    for (const byte of chunk) {
      tail[tailOffset] = byte;
      tailOffset = (tailOffset + 1) % tailLimit;
      tailLength = Math.min(tailLength + 1, tailLimit);
    }
  };

  const orderedTail = () => {
    if (tailLength < tailLimit) return tail.slice(0, tailLength);
    const ordered = new Uint8Array(tailLength);
    ordered.set(tail.subarray(tailOffset), 0);
    ordered.set(tail.subarray(0, tailOffset), tailLength - tailOffset);
    return ordered;
  };

  const retain = (value: Uint8Array) => {
    // Copy only the bounded slices into the fixed head/tail buffers. Copying
    // the entire upstream chunk here would let an unusually large transport
    // chunk temporarily defeat the metering-memory cap.
    const chunk = value;
    const headRemaining = headLimit - headLength;
    if (headRemaining > 0) {
      const take = Math.min(headRemaining, chunk.byteLength);
      head.set(chunk.subarray(0, take), headLength);
      headLength += take;
    }
    appendTail(chunk);
    totalBytes += chunk.byteLength;
  };

  const finish = (complete: boolean) => {
    if (settled) return;
    settled = true;
    try {
      reader.releaseLock();
    } catch {
      // A concurrent hostile read/cancel may keep the reader pending. Metering
      // completion must not depend on secondary lock cleanup succeeding.
    }
    const decoder = new TextDecoder();
    if (totalBytes <= maxBytes) {
      const tailBytes = orderedTail();
      const overlap = Math.max(0, headLength + tailBytes.byteLength - totalBytes);
      const suffix = tailBytes.subarray(overlap);
      const bytes = new Uint8Array(totalBytes);
      bytes.set(head.subarray(0, headLength));
      bytes.set(suffix, headLength);
      resolveCollected({ text: decoder.decode(bytes), truncated: false, complete });
      return;
    }

    // Blank-line separation prevents a cut middle frame from swallowing the
    // first complete SSE frame retained in the tail.
    resolveCollected({
      text: `${decoder.decode(head.subarray(0, headLength))}\n\n${decoder.decode(orderedTail())}`,
      truncated: true,
      complete,
    });
  };

  // A tee lets the eager metering branch pull the upstream faster than the
  // client consumes it, queueing an unbounded response in the other branch.
  // This stream samples each chunk in the same pull that forwards it, so the
  // caller's backpressure governs both forwarding and metering.
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (cancelled) return;
        if (done) {
          finish(!cancelled);
          controller.close();
          return;
        }
        if (value) {
          retain(value);
          controller.enqueue(value);
        }
      } catch (error) {
        finish(false);
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      try {
        void reader.cancel(reason).catch(() => undefined);
      } catch {
        // Nonstandard stream implementations can throw synchronously.
      }
      finish(false);
    },
  });
  return { passthrough, collected };
}

/**
 * /anthropic/v1/messages — auth, forward to Anthropic with the real key,
 * stream the response back unmodified, then meter from a teed copy. Anything
 * except Messages creation and count_tokens is rejected: the proxy is not a
 * general egress and unmetered endpoints never receive the provider key.
 */
export async function handleAnthropic(
  request: Request,
  env: ReviewWorkerEnv,
  deps: HandleAnthropicDeps,
  url: URL,
): Promise<Response> {
  const proxiedPath = url.pathname.slice("/anthropic".length);
  if (!ALLOWED_PROXY_PATHS.has(proxiedPath)) {
    return jsonError(404, "only /v1/messages and /v1/messages/count_tokens are forwarded");
  }
  if (request.method !== "POST") {
    return jsonError(405, "Anthropic proxy routes require POST");
  }
  const maxRequestBytes = deps.anthropicMaxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxMeteringBytes = deps.anthropicMaxMeteringBytes ?? DEFAULT_MAX_METERING_BYTES;
  if (!validByteLimit(maxRequestBytes) || !validByteLimit(maxMeteringBytes)) {
    // Validate both limits before authentication/body handling so a bad Worker
    // deployment can never spend upstream money and fail only while metering.
    return jsonError(500, "invalid Anthropic proxy byte-limit configuration");
  }
  const now = deps.now();
  const auth = await authenticateProxyRequest(request, env, now);
  if (!auth) return jsonError(401, "unauthorized");

  let repo: string;
  let pr: number;
  let sessionHash: string | null = null;
  let spendCapUsd = Number.POSITIVE_INFINITY;
  let spentUsd = 0;
  // Sessions without a live registration retain their historical session-only
  // behavior. A large finite value is bindable by D1; Infinity is not.
  let repoCapUsd = Number.MAX_SAFE_INTEGER;
  if (auth.kind === "session") {
    repo = auth.repo;
    pr = auth.pr;
    sessionHash = auth.hash;
    spendCapUsd = auth.spendCapUsd;
    // Preserve the specific exhausted-cap response before reading the body.
    // The conditional reservation below is the authoritative concurrency gate.
    const fresh = await env.DB
      .prepare("SELECT spent_usd FROM sessions WHERE hash = ?")
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
      repoCapUsd = Math.min(monthlyCapUsd, Number.MAX_SAFE_INTEGER);
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
    repoCapUsd = Math.min(
      monthlyCapUsd,
      auth.spendCapUsd ?? Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
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

  const anthropicBaseUrl = assertHttpUrl(deps.anthropicBaseUrl);
  const upstreamUrl = assertHttpUrl(
    `${anthropicBaseUrl.toString().replace(/\/$/, "")}${proxiedPath}${url.search}`,
  );
  const upstreamHeaders = pickForwardHeaders(request.headers);
  upstreamHeaders.set("x-api-key", env.ANTHROPIC_API_KEY);
  upstreamHeaders.set("anthropic-version", upstreamHeaders.get("anthropic-version") ?? "2023-06-01");

  let upstreamBody: ArrayBuffer;
  try {
    const bytes = await readResponseBytes(
      new Response(request.body, { headers: request.headers }),
      {
        maxBytes: maxRequestBytes,
        signal: request.signal,
      },
    );
    upstreamBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (err) {
    if (request.signal.aborted) throw request.signal.reason ?? err;
    if (isHttpClientPolicyError(err) && err.code === "RESPONSE_TOO_LARGE") {
      return jsonError(413, "request body exceeds the Anthropic proxy limit", {
        maxBytes: maxRequestBytes,
      });
    }
    return jsonError(400, "failed to read request body");
  }

  let countTokensBody: ArrayBuffer | null = null;
  if (proxiedPath === "/v1/messages") {
    const prepared = prepareMessagesRequest(upstreamBody);
    upstreamBody = prepared.body;
    countTokensBody = prepared.countTokensBody;
  }

  // Both provider-key routes require an explicitly priced model. Reserve only
  // Messages creation; count_tokens does not produce a billable message.
  let reservation: SpendReservation | null = null;
  let estimate = estimateMessagesSpend(upstreamBody, now);
  if (!estimate.hasStaticPrice) {
    return jsonError(400, "requested model has no static metering price", {
      reason: "unpriced-model",
    });
  }
  if (estimate.unsupportedBillingFeature) {
    return jsonError(400, "request uses a feature without bounded static metering", {
      reason: estimate.unsupportedBillingFeature,
    });
  }
  if (proxiedPath === "/v1/messages" && countTokensBody) {
    let countedInputTokens: number;
    try {
      countedInputTokens = await countProviderInputTokens({
        url: assertHttpUrl(`${anthropicBaseUrl.toString().replace(/\/$/, "")}/v1/messages/count_tokens`),
        headers: upstreamHeaders,
        body: countTokensBody,
        signal: request.signal,
        fetchUpstream: deps.fetchUpstream,
        allowedOrigins: deps.anthropicAllowedOrigins,
      });
    } catch (err) {
      if (request.signal.aborted) throw request.signal.reason ?? err;
      const detail = String(err).split(env.ANTHROPIC_API_KEY).join("<redacted>");
      return jsonError(502, "upstream token counting failed", { detail });
    }
    estimate = estimateMessagesSpend(upstreamBody, now, countedInputTokens);
  }
  if (proxiedPath === "/v1/messages") {
    reservation = await reserveSpend(env.DB, {
      sessionHash,
      repo,
      repoCapUsd,
      estimate,
      now,
    });
    if (!reservation) {
      return jsonError(402, "spend cap cannot cover the requested message", {
        repo,
        estimatedCostUsd: estimate.amountUsd,
      });
    }
  }

  let upstream: Response;
  try {
    const validateUrl = anthropicRedirectValidator(
      anthropicBaseUrl,
      deps.anthropicAllowedOrigins,
    );
    upstream = await fetchWithPolicy(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: upstreamBody,
      signal: request.signal,
    }, {
      fetch: deps.fetchUpstream,
      allowedOrigins: deps.anthropicAllowedOrigins,
      validateUrl,
    });
  } catch (err) {
    if (reservation) {
      try {
        await releaseSpendReservation(env.DB, reservation.id);
      } catch (releaseError) {
        // Keep the original proxy result. The lease is fail-closed and expires
        // automatically if D1 is temporarily unavailable during release.
        console.error("smithers-review: failed to release spend reservation", {
          repo,
          reservationId: reservation.id,
          err: String(releaseError),
        });
      }
    }
    if (request.signal.aborted) throw request.signal.reason ?? err;
    if (
      isHttpClientPolicyError(err) &&
      (err.code === "INVALID_REDIRECT" || err.code === "CROSS_ORIGIN_BODY_BLOCKED")
    ) {
      const location = typeof err.details.toOrigin === "string"
        ? err.details.toOrigin
        : typeof err.details.to === "string"
          ? err.details.to
          : null;
      return jsonError(
        502,
        "upstream redirected off the anthropic origin; refusing to forward credentials",
        { location },
      );
    }
    const detail = String(err).split(env.ANTHROPIC_API_KEY).join("<redacted>");
    return jsonError(502, "upstream fetch failed", { detail });
  }

  if (!upstream.body) {
    const text = await upstream.text();
    if (reservation) {
      const bodylessMetering = (async () => {
        if (upstream.status < 200 || upstream.status >= 300) {
          await releaseSpendReservation(env.DB, reservation.id);
          return;
        }
        console.error("smithers-review: metering miss (bodyless 2xx messages response)", {
          repo,
          pr,
          path: proxiedPath,
          status: upstream.status,
        });
        await recordUsage(env.DB, {
          sessionHash,
          repo,
          pr,
          summary: {
            model: reservation.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          kind: "messages",
          now,
          reservationId: reservation.id,
          minimumCostUsd: reservation.amountUsd,
        });
      })().catch((err) => {
        console.error("smithers-review: metering failed", {
          repo,
          pr,
          path: proxiedPath,
          status: upstream.status,
          err: String(err),
        });
      });
      deps.waitUntil(bodylessMetering);
    }
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
  const { passthrough, collected } = streamForMetering(
    upstream,
    maxMeteringBytes,
  );

  const metering = (async () => {
    const { text: body, truncated, complete } = await collected;
    if (upstream.status < 200 || upstream.status >= 300) {
      if (reservation) await releaseSpendReservation(env.DB, reservation.id);
      return;
    }
    const summary = contentType.includes("text/event-stream")
      ? parseUsageFromSse(body)
      : parseUsageFromJson(body);
    if (!summary) {
      // A 2xx /v1/messages response that yields no usage is a metering MISS
      // (unexpected body shape), not a benign non-content frame — real spend
      // goes unrecorded. Surface it so Workers logs can catch a parser drift.
      if (proxiedPath === "/v1/messages") {
        console.error("smithers-review: metering miss (usage parser returned null on a 2xx messages response)", {
          repo,
          pr,
          path: proxiedPath,
          contentType,
          truncated,
          complete,
        });
      }
      if (reservation) {
        await recordUsage(env.DB, {
          sessionHash,
          repo,
          pr,
          summary: {
            model: reservation.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          kind: contentType.includes("text/event-stream") ? "messages_stream" : "messages",
          now,
          reservationId: reservation.id,
          minimumCostUsd: reservation.amountUsd,
        });
      }
      return;
    }
    if (
      (summary.serviceTier && summary.serviceTier !== "standard")
      || (summary.inferenceGeo && summary.inferenceGeo !== "global")
    ) {
      // The request body explicitly pins standard_only/global. Retain and
      // surface any provider contract breach instead of silently discarding
      // the authoritative usage fields during settlement.
      console.error("smithers-review: provider violated the static billing boundary", {
        repo,
        pr,
        serviceTier: summary.serviceTier ?? null,
        inferenceGeo: summary.inferenceGeo ?? null,
      });
    }
    await recordUsage(env.DB, {
      sessionHash,
      repo,
      pr,
      summary,
      kind: contentType.includes("text/event-stream") ? "messages_stream" : "messages",
      now,
      reservationId: reservation?.id,
      // A client cancellation or transport error can hide the final usage
      // frame. Charge the pre-dispatch bound rather than silently undercount.
      minimumCostUsd: reservation && !complete ? reservation.amountUsd : undefined,
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
