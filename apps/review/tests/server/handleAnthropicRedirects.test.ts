import { afterEach, describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

const RESPONSE_BODY = JSON.stringify({
  id: "msg_redirect",
  model: "claude-sonnet-4-6",
  content: [],
  usage: { input_tokens: 1, output_tokens: 1 },
});

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

async function seedSession(env: Awaited<ReturnType<typeof buildTestEnv>>) {
  const token = "srs_redirect_test";
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), "octo/redirects", 1, Date.now() + 60_000, 1, 0, Date.now())
    .run();
  return token;
}

function jsonResponse() {
  return new Response(RESPONSE_BODY, { headers: { "content-type": "application/json" } });
}

async function callProxy(
  upstreamUrl: string,
  token: string,
  env: Awaited<ReturnType<typeof buildTestEnv>>,
  options: { allowedOrigins?: string[] } = {},
) {
  const meterings: Promise<unknown>[] = [];
  const worker = createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: upstreamUrl,
    anthropicAllowedOrigins: options.allowedOrigins,
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: (promise) => meterings.push(promise),
  });
  const response = await worker.fetch(
    new Request("https://review.test/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: '{"model":"claude-sonnet-4-6","messages":[]}',
    }),
    env,
  );
  if (response.body) await response.text();
  await Promise.all(meterings);
  return response;
}

describe("Anthropic proxy redirect credential policy", () => {
  test("keeps the upstream key on same-origin redirects", async () => {
    let receivedKey: string | null = null;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/messages") {
          return new Response(null, { status: 307, headers: { location: "/same-target" } });
        }
        receivedKey = request.headers.get("x-api-key");
        return jsonResponse();
      },
    });
    servers.push(upstream);
    const env = await buildTestEnv();
    const token = await seedSession(env);
    const response = await callProxy(`http://127.0.0.1:${upstream.port}`, token, env);
    expect(response.status).toBe(200);
    expect(receivedKey as string | null).toBe("sk-ant-test");
  });

  test("blocks a body-preserving cross-origin redirect before the key reaches it", async () => {
    let receiverCalls = 0;
    const receiver = Bun.serve({ port: 0, fetch: () => { receiverCalls += 1; return jsonResponse(); } });
    servers.push(receiver);
    const upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${receiver.port}/target` },
        }),
    });
    servers.push(upstream);
    const env = await buildTestEnv();
    const token = await seedSession(env);
    const response = await callProxy(`http://127.0.0.1:${upstream.port}`, token, env);
    expect(response.status).toBe(502);
    expect(receiverCalls).toBe(0);
  });

  test("validates every hop and strips the key before an unauthorized final origin", async () => {
    let receivedKey: string | null = "not-called";
    const receiver = Bun.serve({
      port: 0,
      fetch(request) {
        receivedKey = request.headers.get("x-api-key");
        return jsonResponse();
      },
    });
    servers.push(receiver);
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        return path === "/v1/messages"
          ? new Response(null, { status: 302, headers: { location: "/hop" } })
          : new Response(null, {
              status: 307,
              headers: { location: `http://127.0.0.1:${receiver.port}/target` },
            });
      },
    });
    servers.push(upstream);
    const env = await buildTestEnv();
    const token = await seedSession(env);
    const response = await callProxy(`http://127.0.0.1:${upstream.port}`, token, env);
    expect(response.status).toBe(200);
    expect(receivedKey).toBeNull();
  });

  test("retains the key for an explicitly authorized redirect origin", async () => {
    let receivedKey: string | null = null;
    const receiver = Bun.serve({
      port: 0,
      fetch(request) {
        receivedKey = request.headers.get("x-api-key");
        return jsonResponse();
      },
    });
    servers.push(receiver);
    const receiverOrigin = `http://127.0.0.1:${receiver.port}`;
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: `${receiverOrigin}/target` } }),
    });
    servers.push(upstream);
    const env = await buildTestEnv();
    const token = await seedSession(env);
    const response = await callProxy(
      `http://127.0.0.1:${upstream.port}`,
      token,
      env,
      { allowedOrigins: [receiverOrigin] },
    );
    expect(response.status).toBe(200);
    expect(receivedKey as string | null).toBe("sk-ant-test");
  });
});
