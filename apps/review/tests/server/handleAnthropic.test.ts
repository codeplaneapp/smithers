import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { serveFixtureAnthropic } from "./helpers/serveFixtureAnthropic.ts";

const REPO = "octo/widgets";

const SSE_USAGE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const SINGLE_CALL_COST_USD = 0.00153;
let usageId = 0;

const SSE_USAGE_WITH_CACHE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m2","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1,"cache_creation_input_tokens":200,"cache_read_input_tokens":4000}}}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":42}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
].join("\n");

function sseUsageWithLargeBodyBeforeFinalUsage(): string {
  return [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}',
    "",
    'event: content_block_delta',
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${"x".repeat((1 << 20) + 1024)}"}}`,
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
}

async function seedSession(env: ReviewWorkerEnv, repo: string, spendCapUsd = 1) {
  const token = "srs_testsessiontoken";
  const hash = await sha256Hex(token);
  await env.DB
    .prepare(
      "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash, repo, 99, Date.now() + 60_000, spendCapUsd, 0, Date.now())
    .run();
  return token;
}

async function registerRepo(env: ReviewWorkerEnv, repo: string, prsPerMonth = 5, spendCapUsd = 1) {
  await env.DB
    .prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(repo, "auto", prsPerMonth, spendCapUsd, Date.now())
    .run();
}

async function seedUsage(env: ReviewWorkerEnv, repo: string, costUsd: number) {
  await env.DB
    .prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(`usage-${usageId++}`, repo, 1, "claude-sonnet-4-6", 0, 0, costUsd, "messages", Date.now())
    .run();
}

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
});

function makeWorker(anthropicBaseUrl: string) {
  return {
    pendingMeter: [] as Promise<unknown>[],
    worker: createReviewWorker({
      jwksUrl: "http://unused",
      fetchUpstream: fetch,
      now: () => Date.now(),
      anthropicBaseUrl,
      waitUntil: () => undefined,
    }),
  };
}

describe("anthropic proxy", () => {
  test("rejects requests outside /v1/", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const harness = makeWorker(fixture.baseUrl);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v2/messages", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(404);
    // unused
    void harness;
  });

  test("401s unknown sessions", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "unknown" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("rejects an unpriced request model before any upstream call", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    let upstreamCalls = 0;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => {
        upstreamCalls += 1;
        return new Response(SSE_USAGE, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-future-unpriced","max_tokens":100,"messages":[]}',
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("no static metering price");
    expect(upstreamCalls).toBe(0);
    const reservations = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(reservations.results.length).toBe(0);
  });

  test("does not price an arbitrary premium suffix as its cheap base model", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    let upstreamCalls = 0;
    const worker = createReviewWorker({
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => {
        upstreamCalls += 1;
        return new Response("unreachable");
      }) as unknown as typeof fetch,
    });
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-haiku-4-5-premium","max_tokens":100,"messages":[]}',
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(upstreamCalls).toBe(0);
  });

  test("rejects alternate routes and non-POST methods before upstream", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    let upstreamCalls = 0;
    const worker = createReviewWorker({
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => {
        upstreamCalls += 1;
        return new Response("unreachable");
      }) as unknown as typeof fetch,
    });
    const alternateRoute = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages/batches", {
        method: "POST",
        headers: { "x-api-key": token },
      }),
      env,
    );
    const wrongMethod = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "GET",
        headers: { "x-api-key": token },
      }),
      env,
    );
    expect(alternateRoute.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(upstreamCalls).toBe(0);
  });

  test("allows POST count_tokens without creating a spend reservation", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    let upstreamCalls = 0;
    const worker = createReviewWorker({
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async (input: string | URL | Request) => {
        upstreamCalls += 1;
        expect(new URL(String(input)).pathname).toBe("/v1/messages/count_tokens");
        return new Response('{"input_tokens":12}', {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      waitUntil: (promise) => meterings.push(promise),
    });
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages/count_tokens", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 12 });
    await Promise.all(meterings);
    expect(upstreamCalls).toBe(1);
    const reservations = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(reservations.results.length).toBe(0);
  });

  test("rejects invalid request and metering byte limits before upstream", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    let upstreamCalls = 0;
    const fetchUpstream = (async () => {
      upstreamCalls += 1;
      return new Response("unreachable");
    }) as unknown as typeof fetch;
    const invalidMetering = createReviewWorker({
      anthropicBaseUrl: "https://anthropic.test",
      anthropicMaxMeteringBytes: -1,
      fetchUpstream,
    });
    const invalidRequest = createReviewWorker({
      anthropicBaseUrl: "https://anthropic.test",
      anthropicMaxRequestBytes: -1,
      fetchUpstream,
    });
    const meteringResponse = await invalidMetering.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
      }),
      env,
    );
    // No body: request-limit validation must not depend on the body reader.
    const requestResponse = await invalidRequest.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
      }),
      env,
    );
    expect(meteringResponse.status).toBe(500);
    expect(requestResponse.status).toBe(500);
    expect(upstreamCalls).toBe(0);
  });

  test("forwards to api.anthropic.com with the real key and meters SSE usage", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(fixture.requests.length).toBe(1);
    expect(fixture.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(fixture.requests[0].headers["x-api-key"]).not.toBe(token);
    await Promise.all(meterings);
    const usage = await env.DB.prepare("SELECT * FROM usage_events").all();
    expect(usage.results.length).toBe(1);
    const row = usage.results[0] as Record<string, unknown>;
    expect(row.repo).toBe(REPO);
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.input_tokens).toBe(300);
    expect(row.output_tokens).toBe(42);
    expect(row.kind).toBe("messages_stream");
    // 300 * 3/1e6 + 42 * 15/1e6 = 0.0009 + 0.00063 = 0.00153
    expect(row.cost_usd as number).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
  });

  test("persists cache token counts so cache-heavy spend can be explained and backfilled", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE_WITH_CACHE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(42);
    expect(row?.cache_creation_tokens).toBe(200);
    expect(row?.cache_read_tokens).toBe(4000);
    // Cost folds cache tokens in: 10*3 + 42*15 + 200*3.75 + 4000*0.3 = per-1e6 USD.
    const expected = (10 * 3 + 42 * 15 + 200 * 3.75 + 4000 * 0.3) / 1_000_000;
    expect(row?.cost_usd as number).toBeCloseTo(expected, 9);
  });

  test("meters SSE usage after more than 1 MiB of streamed content", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const encoder = new TextEncoder();
    const bodyParts = sseUsageWithLargeBodyBeforeFinalUsage().split("\n\nevent: message_delta");
    const fetchUpstream = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(bodyParts[0]));
            controller.enqueue(encoder.encode(`\n\nevent: message_delta${bodyParts[1]}`));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      // Exercise the bounded head/tail collector: the response is over 1 MiB,
      // while metering may retain only 1 KiB.
      anthropicMaxMeteringBytes: 1024,
      fetchUpstream,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);

    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.input_tokens).toBe(300);
    expect(row?.output_tokens).toBe(42);
    expect(row?.cost_usd as number).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
  });

  test("rejects oversized request bodies before contacting Anthropic and accepts the exact cap", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const exactBody = '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}';
    const maxRequestBytes = new TextEncoder().encode(exactBody).byteLength;
    let upstreamCalls = 0;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      anthropicMaxRequestBytes: maxRequestBytes,
      fetchUpstream: (async () => {
        upstreamCalls += 1;
        return new Response(SSE_USAGE, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });

    const oversized = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: `${exactBody} `,
      }),
      env,
    );
    expect(oversized.status).toBe(413);
    expect(upstreamCalls).toBe(0);

    const streamed = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(exactBody.slice(0, 10)));
            controller.enqueue(new TextEncoder().encode(`${exactBody.slice(10)} `));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      env,
    );
    expect(streamed.status).toBe(413);
    expect(upstreamCalls).toBe(0);

    const exact = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: exactBody,
      }),
      env,
    );
    expect(exact.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    await exact.text();
  });

  test("propagates the caller's exact cancellation reason through the upstream request", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async (_url: string | URL | Request, init?: RequestInit) => {
        started();
        const signal = init?.signal;
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      }) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const controller = new AbortController();
    const pending = worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
        signal: controller.signal,
      }),
      env,
    );
    await upstreamStarted;
    const reason = new DOMException("cancelled by caller", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("does not pull an upstream stream ahead of a slow response consumer", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    let pulls = 0;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => new Response(new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > 50) controller.close();
          else controller.enqueue(new Uint8Array([pulls]));
        },
      }), { status: 500, headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: (promise) => meterings.push(promise),
    });

    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
      }),
      env,
    );
    await Bun.sleep(10);
    expect(pulls).toBeLessThan(50);
    await response.body?.cancel("test complete");
    await Promise.all(meterings);
  });

  test("charges the reservation when a 2xx messages response yields no usage", async () => {
    const env = await buildTestEnv();
    // A 200 /v1/messages body with no `model`: parseUsageFromJson returns null,
    // so real spend would go unrecorded. That must be surfaced, not swallowed.
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: '{"id":"x","content":[]}' });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await worker.fetch(
        new Request("https://review.test/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": token, "content-type": "application/json" },
          body: '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[]}',
        }),
        env,
      );
      expect(res.status).toBe(200);
      await res.text();
      await Promise.all(meterings);
      const logged = errorSpy.mock.calls.some((call) => String(call[0]).includes("metering miss"));
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
    const usage = await env.DB.prepare("SELECT cost_usd FROM usage_events").all<{ cost_usd: number }>();
    expect(usage.results.length).toBe(1);
    expect(usage.results[0].cost_usd).toBeGreaterThan(0);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd).toBeCloseTo(usage.results[0].cost_usd, 9);
    const reservations = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(reservations.results.length).toBe(0);
  });

  test("atomically admits only one concurrent request when two reservations exceed the cap", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Each body reserves about $0.001725 (request bytes at the highest prompt
    // rate plus 100 possible output tokens). One fits; two do not.
    const token = await seedSession(env, REPO, 0.002);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const makeRequest = () =>
      worker.fetch(
        new Request("https://review.test/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": token, "content-type": "application/json" },
          body: '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[]}',
        }),
        env,
      );

    const [first, second] = await Promise.all([makeRequest(), makeRequest()]);
    expect([first.status, second.status].sort()).toEqual([200, 402]);
    await Promise.all([first.text(), second.text()]);
    await Promise.all(meterings);

    expect(fixture.requests.length).toBe(1);
    const usage = await env.DB.prepare("SELECT cost_usd FROM usage_events").all<{ cost_usd: number }>();
    expect(usage.results.length).toBe(1);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
    const reservations = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(reservations.results.length).toBe(0);
  });

  test("prunes expired leases before admission so crashed Workers cannot strand capacity", async () => {
    const env = await buildTestEnv();
    const now = Date.now();
    const token = await seedSession(env, REPO);
    await env.DB
      .prepare(
        "INSERT INTO spend_reservations (id, session_hash, repo, amount_usd, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("expired", await sha256Hex(token), REPO, 100, now - 1, now - 10_000)
      .run();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => now,
      waitUntil: (promise) => meterings.push(promise),
    });

    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
      }),
      env,
    );
    expect(response.status).toBe(200);
    const active = await env.DB.prepare("SELECT id FROM spend_reservations").all<{ id: string }>();
    expect(active.results.length).toBe(1);
    expect(active.results[0].id).not.toBe("expired");

    await response.text();
    await Promise.all(meterings);
    const remaining = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(remaining.results.length).toBe(0);
  });

  test("settles an aborted SSE stream at the conservative reserved amount", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const encoder = new TextEncoder();
    const partialSse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}',
      "",
    ].join("\n");
    let upstreamCancelled = false;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(partialSse));
        },
        cancel() {
          upstreamCancelled = true;
        },
      }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: (promise) => meterings.push(promise),
    });
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":100,"messages":[]}',
      }),
      env,
    );
    expect(response.status).toBe(200);
    const active = await env.DB
      .prepare("SELECT amount_usd FROM spend_reservations")
      .first<{ amount_usd: number }>();
    expect(active?.amount_usd ?? 0).toBeGreaterThan(SINGLE_CALL_COST_USD);

    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain("message_start");
    await reader.cancel("test abort after first SSE frame");
    await Promise.all(meterings);

    expect(upstreamCancelled).toBe(true);
    const usage = await env.DB
      .prepare("SELECT output_tokens, cost_usd FROM usage_events")
      .first<{ output_tokens: number; cost_usd: number }>();
    expect(usage?.output_tokens).toBe(1);
    expect(usage?.cost_usd ?? 0).toBeCloseTo(active!.amount_usd, 9);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(active!.amount_usd, 9);
    const reservations = await env.DB.prepare("SELECT id FROM spend_reservations").all();
    expect(reservations.results.length).toBe(0);
  });

  test("meters non-streaming JSON response and records kind=messages", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 150, output_tokens: 30 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.kind).toBe("messages");
    expect(row?.model).toBe("claude-sonnet-4-6");
    expect(row?.input_tokens).toBe(150);
    expect(row?.output_tokens).toBe(30);
    // 150 * 3/1e6 + 30 * 15/1e6 = 0.00045 + 0.00045 = 0.0009
    expect(row?.cost_usd as number).toBeCloseTo(0.0009, 6);
  });

  test("authenticates srk_ api-key and proxies request with usage attributed to repo", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, "octo/widgets");
    const apiKey = "srk_testoperatorkey";
    const keyHash = await sha256Hex(apiKey);
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(keyHash, "octo", JSON.stringify(["octo/widgets"]), Date.now())
      .run();
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(fixture.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(fixture.requests[0].headers["x-api-key"]).not.toBe(apiKey);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.repo).toBe("octo/widgets");
    expect(row?.kind).toBe("messages");
    expect(row?.input_tokens).toBe(100);
    expect(row?.output_tokens).toBe(20);
  });

  test("401s srk_ key not in api_keys table", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "srk_unknownkey" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("402s when session spend cap is already at or above limit", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO, 0.001);
    // Bump spent above cap.
    const hash = await sha256Hex(token);
    await env.DB.prepare("UPDATE sessions SET spent_usd = ? WHERE hash = ?").bind(0.005, hash).run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(402);
  });

  test("attributes srk_ spend to the repo named in x-smithers-repo", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_03",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, "octo/widgets");
    await registerRepo(env, "octo/wrenches");
    const apiKey = "srk_multirepo";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/widgets", "octo/wrenches"]), Date.now())
      .run();
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "octo/wrenches",
          "content-type": "application/json",
        },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT repo FROM usage_events").first<{ repo: string }>();
    expect(row?.repo).toBe("octo/wrenches");
  });

  test("403s an x-smithers-repo hint outside the srk_ key's repo list", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_limitedkey";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/widgets"]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "evil/other",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(fixture.requests.length).toBe(0);
  });

  test("403s srk_ proxy requests for unregistered repos", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_unregistered";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/missing"]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("repo not registered");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s srk_ proxy requests once the repo monthly spend cap is reached", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, REPO, 1, 0.01);
    await seedUsage(env, REPO, 0.02);
    const apiKey = "srk_spentrepo";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("monthly spend cap");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s an srk_ key once its own per-key spend cap is reached (below the repo monthly cap)", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, REPO, 100, 1);
    await seedUsage(env, REPO, 0.02);
    const apiKey = "srk_spentkey";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), 0.01, Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("api key spend cap");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s a re-minted session once the repo's monthly spend cap is reached", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Plan ceiling = prs_per_month * spend_cap_usd = 1 * 0.01 = 0.01.
    await env.DB
      .prepare(
        "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(REPO, "auto", 1, 0.01, Date.now())
      .run();
    // Month-to-date spend already crossed the ceiling.
    await env.DB
      .prepare(
        "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("u1", REPO, 1, "claude-sonnet-4-6", 0, 0, 0.02, "messages", Date.now())
      .run();
    // A fresh session: spent_usd = 0 with a high per-session cap, i.e. a re-mint
    // that reset the per-session budget. The per-repo ceiling must still bite.
    const token = await seedSession(env, REPO, 1);
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("monthly spend cap");
    // Enforced pre-flight: no real Anthropic call was made.
    expect(fixture.requests.length).toBe(0);
  });

  test("forwards for a registered repo still under its monthly spend cap", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Ceiling = 5 * 1 = 5; nothing spent yet.
    await env.DB
      .prepare(
        "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(REPO, "auto", 5, 1, Date.now())
      .run();
    const token = await seedSession(env, REPO, 1);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);
    expect(fixture.requests.length).toBe(1);
  });

  test("forwards retry-after and x-request-id from upstream responses", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({
      status: 429,
      contentType: "application/json",
      body: '{"type":"error","error":{"type":"rate_limit_error"}}',
      headers: { "retry-after": "17", "x-request-id": "req_abc123" },
    });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(res.headers.get("x-request-id")).toBe("req_abc123");
  });

  test("403s an x-smithers-repo hint from a key scoped to NO repos (no cross-tenant spend)", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    // A registered victim repo the attacker would love to bill against.
    await registerRepo(env, "victim/repo");
    const apiKey = "srk_noreposkey";
    // repos_json = [] — an unscoped key. Previously the hint check was
    // `auth.repos.length > 0 && !includes(hint)`, which is vacuously false for
    // an empty list, so the hint was accepted and the key could meter spend
    // against ANY repo. Must 403 before any upstream call.
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "victim/repo",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("not scoped to any repo");
    expect(fixture.requests.length).toBe(0);
  });

  test("403s a no-repos key with no hint with an actionable message (not 'repo not registered')", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_noreposnohint";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // The old code fell back to auth.owner ("octo") and 403'd on the misleading
    // "repo not registered"; now the message points at the real fix (mint a
    // repo-scoped key).
    expect(body.error).toContain("not scoped to any repo");
    expect(body.error).not.toContain("repo not registered");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s at exactly spend == cap (>= boundary) and names repo + month", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    // Ceiling = prs_per_month * spend_cap_usd = 1 * 0.01 = 0.01; spend exactly 0.01.
    await registerRepo(env, REPO, 1, 0.01);
    await seedUsage(env, REPO, 0.01);
    const apiKey = "srk_boundarykey";
    await env.DB
      .prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; repo: string; month: string };
    expect(body.error).toContain("monthly spend cap");
    expect(body.repo).toBe(REPO);
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(fixture.requests.length).toBe(0);
  });
});
