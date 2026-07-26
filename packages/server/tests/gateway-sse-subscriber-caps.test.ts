import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { connect } from "node:net";
import { Gateway } from "../src/gateway.js";

/**
 * /v1/api/stream subscriber bounds, driven over real HTTP sockets:
 *
 * - per-connection (`x-request-id`), per-user, and global subscriber caps
 *   reject with a 429 RateLimited JSON body and free their slots on
 *   disconnect;
 * - every subscriber shares ONE heartbeat interval (torn down when the last
 *   subscriber leaves);
 * - one invalidation is delivered exactly once per subscriber (no duplicate
 *   generic copy);
 * - a paused real socket keeps its outbound queue byte-bounded, never wedges
 *   healthy subscribers, and recovers through a reset after it drains.
 */

setDefaultTimeout(120_000);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

async function bootGateway() {
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
        "second-token": { role: "admin", scopes: ["*"], userId: "user:second" },
      },
    },
  });
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  const port = getPort(server);
  return { gateway: gateway as any, baseUrl: `http://127.0.0.1:${port}`, port };
}

type SseEvent = { event: string; data: any };

async function openStream(
  baseUrl: string,
  {
    token = "operator-token",
    requestId,
    lastEventId,
  }: { token?: string; requestId?: string; lastEventId?: number } = {},
) {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/v1/api/stream`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(requestId ? { "x-request-id": requestId } : {}),
      ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}),
    },
    signal: abort.signal,
  });
  const events: SseEvent[] = [];
  if (response.status === 200 && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const read = await reader.read();
          if (read.done) return;
          buffer += decoder.decode(read.value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
            const dataLine = lines.find((line) => line.startsWith("data: "));
            events.push({ event, data: dataLine ? JSON.parse(dataLine.slice(6)) : null });
          }
        }
      } catch {}
    })();
  } else {
    await response.text().catch(() => undefined);
  }
  cleanups.push(() => abort.abort());
  return {
    response,
    events,
    close: () => abort.abort(),
    async waitForEvent(predicate: (event: SseEvent) => boolean, label = "SSE event", timeoutMs = 10_000) {
      const started = Date.now();
      for (;;) {
        const match = events.find(predicate);
        if (match) return match;
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await sleep(10);
      }
    },
  };
}

async function fetchRejection(baseUrl: string, requestId?: string, token = "operator-token") {
  const response = await fetch(`${baseUrl}/v1/api/stream`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
  const json = (await response.json()) as { ok: boolean; error: { code: string; details: unknown } };
  return { response, json };
}

describe("Gateway SSE cursor validation", () => {
  test("invalid header and query cursors return JSON 400 responses without registering subscribers", async () => {
    const { gateway, baseUrl } = await bootGateway();
    const invalidRequests = [
      { path: "/v1/api/stream", headers: { "last-event-id": "not-a-number" } },
      { path: "/v1/api/stream?lastEventId=-1", headers: {} },
    ];

    for (const request of invalidRequests) {
      const response = await fetch(`${baseUrl}${request.path}`, {
        headers: {
          authorization: "Bearer operator-token",
          ...request.headers,
        },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toStartWith("application/json");
      expect(await response.json()).toEqual({
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "Last-Event-ID must be a non-negative integer.",
        },
      });
    }

    expect(gateway.apiStreamSubscribers.size).toBe(0);
    expect(gateway.apiStreamSubscribersByUser.size).toBe(0);
    expect(gateway.apiStreamSubscribersByConnection.size).toBe(0);
    expect(gateway.apiStreamHeartbeatTimer).toBeNull();
  });

  test("a valid cursor replays only newer frames", async () => {
    const { gateway, baseUrl } = await bootGateway();
    const firstSeq = await gateway.queueApiInvalidation(["runs"]);
    const secondSeq = await gateway.queueApiInvalidation(["cron"]);

    const resumed = await openStream(baseUrl, { lastEventId: firstSeq });
    expect(resumed.response.status).toBe(200);
    const replayed = await resumed.waitForEvent(
      (event) => event.event === "change" && event.data?.seq === secondSeq,
      "replayed SSE frame",
    );
    expect(replayed.data.collections).toEqual(["cron"]);
    expect(resumed.events.some((event) => event.event === "change" && event.data?.seq === firstSeq)).toBe(false);
  });
});

describe("Gateway SSE subscriber caps", () => {
  test("per-connection cap rejects a third stream for one x-request-id and frees the slot on disconnect", async () => {
    const { gateway, baseUrl } = await bootGateway();
    expect(gateway.apiStreamMaxSubscribersPerConnection).toBe(2);

    const first = await openStream(baseUrl, { requestId: "conn-a" });
    const second = await openStream(baseUrl, { requestId: "conn-a" });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);

    const rejected = await fetchRejection(baseUrl, "conn-a");
    expect(rejected.response.status).toBe(429);
    expect(rejected.json.ok).toBe(false);
    expect(rejected.json.error.code).toBe("RateLimited");
    expect(rejected.json.error.details).toEqual({ scope: "connection", limit: 2 });

    // A different declared connection id is unaffected by conn-a's cap.
    const other = await openStream(baseUrl, { requestId: "conn-b" });
    expect(other.response.status).toBe(200);

    // Cleanup on disconnect gives the slot back.
    first.close();
    await waitFor(
      () => (gateway.apiStreamSubscribersByConnection.get("api-stream:conn-a") ?? 0) === 1,
      "conn-a slot release",
    );
    const replacement = await openStream(baseUrl, { requestId: "conn-a" });
    expect(replacement.response.status).toBe(200);
  });

  test("per-user cap rejects the over-cap user but not another user, and releases on close", async () => {
    const { gateway, baseUrl } = await bootGateway();
    // Production default; shrunk so the test exercises the real cap check
    // without opening 32 sockets.
    expect(gateway.apiStreamMaxSubscribersPerUser).toBe(32);
    gateway.apiStreamMaxSubscribersPerUser = 2;

    const first = await openStream(baseUrl, { requestId: "user-a-1" });
    const second = await openStream(baseUrl, { requestId: "user-a-2" });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);

    const rejected = await fetchRejection(baseUrl, "user-a-3");
    expect(rejected.response.status).toBe(429);
    expect(rejected.json.error.code).toBe("RateLimited");
    expect(rejected.json.error.details).toEqual({ scope: "user", limit: 2 });

    // A different user identity still gets a stream.
    const otherUser = await openStream(baseUrl, { token: "second-token", requestId: "user-b-1" });
    expect(otherUser.response.status).toBe(200);

    second.close();
    await waitFor(
      () => (gateway.apiStreamSubscribersByUser.get("user:operator") ?? 0) === 1,
      "user:operator slot release",
    );
    const replacement = await openStream(baseUrl, { requestId: "user-a-4" });
    expect(replacement.response.status).toBe(200);
  });

  test("global cap rejects every new subscriber and full teardown clears counters and the shared heartbeat", async () => {
    const { gateway, baseUrl } = await bootGateway();
    expect(gateway.apiStreamMaxSubscribers).toBe(256);
    gateway.apiStreamMaxSubscribers = 2;

    const first = await openStream(baseUrl, { requestId: "global-1" });
    const second = await openStream(baseUrl, { token: "second-token", requestId: "global-2" });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(gateway.apiStreamHeartbeatTimer).not.toBeNull();

    // Even a different user is rejected once the global cap is reached.
    const rejected = await fetchRejection(baseUrl, "global-3", "second-token");
    expect(rejected.response.status).toBe(429);
    expect(rejected.json.error.details).toEqual({ scope: "global", limit: 2 });

    first.close();
    await waitFor(() => gateway.apiStreamSubscribers.size === 1, "global slot release");
    const replacement = await openStream(baseUrl, { requestId: "global-4" });
    expect(replacement.response.status).toBe(200);

    // Closing every stream empties the subscriber set, both counter maps, and
    // stops the single shared heartbeat interval.
    second.close();
    replacement.close();
    await waitFor(
      () =>
        gateway.apiStreamSubscribers.size === 0 &&
        gateway.apiStreamSubscribersByUser.size === 0 &&
        gateway.apiStreamSubscribersByConnection.size === 0 &&
        gateway.apiStreamHeartbeatTimer === null,
      "full subscriber teardown",
    );
  });

  test("one gateway event delivers exactly one change frame per subscriber", async () => {
    const { gateway, baseUrl } = await bootGateway();
    const streams = await Promise.all([
      openStream(baseUrl, { requestId: "multi-1" }),
      openStream(baseUrl, { token: "second-token", requestId: "multi-2" }),
      openStream(baseUrl, { requestId: "multi-3" }),
    ]);
    for (const stream of streams) {
      expect(stream.response.status).toBe(200);
      await stream.waitForEvent((event) => event.event === "heartbeat", "initial heartbeat");
    }

    // Real broadcast entry point: run lifecycle events funnel through
    // broadcastEvent -> queueApiInvalidation -> one coalesced SSE frame.
    gateway.broadcastEvent("run.started", { runId: "run-sse-multi" });
    for (const stream of streams) {
      await stream.waitForEvent(
        (event) =>
          event.event === "change" && Array.isArray(event.data?.collections) && event.data.collections.includes("runs"),
        "coalesced change frame",
      );
    }
    // Wait out the coalesce window plus slack: any duplicate generic copy
    // would have landed by now.
    await sleep(250);

    const seq = gateway.apiStreamSeq;
    expect(seq).toBeGreaterThan(0);
    for (const stream of streams) {
      const changes = stream.events.filter((event) => event.event === "change");
      expect(changes).toHaveLength(1);
      expect(changes[0]?.data?.seq).toBe(seq);
    }
  });

  test("a slow real socket stays byte-bounded, never wedges healthy subscribers, and recovers via reset", async () => {
    const { gateway, baseUrl, port } = await bootGateway();

    // Slow consumer: a raw TCP client that stops reading after the first
    // heartbeat, so the server-side socket genuinely backs up.
    const slow = connect({ host: "127.0.0.1", port });
    cleanups.push(() => slow.destroy());
    await new Promise<void>((resolve, reject) => {
      slow.once("connect", () => resolve());
      slow.once("error", reject);
    });
    let received = "";
    slow.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    slow.write(
      [
        "GET /v1/api/stream HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Authorization: Bearer operator-token",
        "X-Request-Id: slow-consumer",
        "Accept: text/event-stream",
        "",
        "",
      ].join("\r\n"),
    );
    await waitFor(() => received.includes("event: heartbeat"), "slow consumer handshake");
    slow.pause();

    const healthy = await openStream(baseUrl, { requestId: "healthy-consumer" });
    expect(healthy.response.status).toBe(200);

    const serverSideSlow = [...gateway.apiStreamSubscribers].find(
      (subscriber: any) => subscriber.id === "slow-consumer",
    ) as any;
    expect(serverSideSlow).toBeDefined();

    // Pump invalidation bytes through the real flush path until the paused
    // socket's server-side queue overflows, yielding periodically so the
    // in-process healthy reader can keep consuming. How many frames that
    // takes depends on the host kernel's socket buffers (Linux runners
    // absorb megabytes before the userspace queue backs up), so pump until
    // overflow with a generous hard cap instead of a fixed frame count.
    for (let batch = 0; batch < 2000 && !serverSideSlow.needsReset; batch += 1) {
      for (let i = 0; i < 100; i += 1) {
        gateway.apiStreamPendingCollections.add("runs");
        gateway.flushApiInvalidation();
      }
      expect(serverSideSlow.queue.length).toBeLessThanOrEqual(256);
      expect(serverSideSlow.queueBytes).toBeLessThanOrEqual(64 * 1024);
      if (batch % 20 === 0) await sleep(5);
    }
    // The paused socket must have overflowed the bounded queue at least once
    // (dropping to a reset marker instead of buffering without bound).
    expect(serverSideSlow.needsReset).toBe(true);
    expect(serverSideSlow.queue.length).toBeLessThanOrEqual(256);
    expect(serverSideSlow.queueBytes).toBeLessThanOrEqual(64 * 1024);

    // The healthy subscriber still observes fresh invalidations end-to-end.
    const seqAfter = (await gateway.queueApiInvalidation(["runs"])) as number;
    await healthy.waitForEvent(
      (event) => event.event === "change" && event.data?.seq === seqAfter,
      "healthy subscriber tail frame",
    );

    // Once the slow client drains, it gets a reset (not the dropped backlog),
    // then live frames again.
    const drainedFrom = received.length;
    slow.resume();
    await waitFor(() => received.slice(drainedFrom).includes("event: reset"), "reset after drain");
    const recoverySeq = (await gateway.queueApiInvalidation(["runs"])) as number;
    await waitFor(() => received.includes(`id: ${recoverySeq}`), "live frame after recovery");
  });
});
