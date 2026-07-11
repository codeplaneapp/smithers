import { afterEach, describe, expect, test } from "bun:test";
import { startInferenceBroker, type InferenceBroker } from "../../action/src/inferenceBroker";

describe("loopback inference credential broker", () => {
  let broker: InferenceBroker | null = null;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    broker?.stop();
    upstream?.stop(true);
    broker = null;
    upstream = null;
  });

  test("injects the real session only upstream while the client sees a local key", async () => {
    const seen: { key?: string; body?: string } = {};
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.key = request.headers.get("x-api-key") ?? "";
        seen.body = await request.text();
        return new Response('data: {"ok":true}\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    broker = startInferenceBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/anthropic`,
      sessionToken: "srs_real_secret",
    });
    expect(broker.clientKey).not.toContain("srs_real_secret");
    const response = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": broker.clientKey, "content-type": "application/json" },
      body: '{"model":"test"}',
    });
    expect(response.status).toBe(200);
    expect(seen.key).toBe("srs_real_secret");
    expect(seen.body).toBe('{"model":"test"}');
  });

  test("rejects missing local auth, extra routes, queries, and oversized declared bodies", async () => {
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    broker = startInferenceBroker({
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/anthropic`,
      sessionToken: "srs_real_secret",
    });
    expect((await fetch(`${broker.baseUrl}/v1/messages`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${broker.baseUrl}/v1/complete`, {
      method: "POST",
      headers: { "x-api-key": broker.clientKey },
    })).status).toBe(404);
    expect((await fetch(`${broker.baseUrl}/v1/messages?redirect=x`, {
      method: "POST",
      headers: { "x-api-key": broker.clientKey },
    })).status).toBe(404);
    expect((await fetch(`${broker.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": broker.clientKey },
      body: new Uint8Array(33 * 1024 * 1024),
    })).status).toBe(413);
  });
});
