import { afterEach, describe, expect, test } from "bun:test";
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

  test("records concurrent session usage without exceeding the spend cap", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO, SINGLE_CALL_COST_USD + 0.00001);
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
          body: '{"model":"claude-sonnet-4-6","messages":[]}',
        }),
        env,
      );

    const [first, second] = await Promise.all([makeRequest(), makeRequest()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await Promise.all([first.text(), second.text()]);
    await Promise.all(meterings);

    const usage = await env.DB.prepare("SELECT cost_usd FROM usage_events").all<{ cost_usd: number }>();
    expect(usage.results.length).toBe(1);
    expect(usage.results[0].cost_usd).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
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
});
