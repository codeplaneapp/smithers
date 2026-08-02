import { afterEach, describe, expect, test } from "bun:test";
import { renderPrometheusMetrics } from "@smthrs/observability";
import { randomBytes } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { Gateway } from "../src/gateway.js";

// Responses and events must all use one byte-bounded writer. A controllable
// fake socket gives exact ordering and backpressure assertions without
// allocating tens of megabytes per test.

// Mirror the CONNECTION_EVENT_* constants in src/gateway.js.
const QUEUE_MAX_BYTES = 32 * 1024 * 1024;
const BACKPRESSURE_CLOSE_CODE = 1013;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeConnection({ bufferedAmount = 0 } = {}) {
  const sent = [];
  const closes = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close(code, reason) {
      closes.push({ code, reason });
      this.readyState = 3;
    },
  };
  return {
    id: "conn-writer",
    connectionId: "conn-writer",
    transport: "ws",
    role: "operator",
    scopes: ["*"],
    userId: "user:writer",
    authenticated: true,
    seq: 0,
    subscribedRuns: null,
    ws,
    sent,
    closes,
    runEventStreams: undefined,
    eventWriter: null,
  };
}

describe("gateway connection writer", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {ReturnType<typeof makeFakeConnection> | undefined} */
  let connection;

  afterEach(() => {
    if (gateway && connection) {
      gateway.cleanupRunEventSubscribers(connection);
      gateway.connections.delete(connection);
      // Kill any pending drain-retry timers.
      connection.ws.readyState = 3;
    }
    gateway = undefined;
    connection = undefined;
  });

  test("the generic broadcast copy cannot bypass a congested socket and drains losslessly on recovery", async () => {
    gateway = new Gateway({});
    // 16 MiB buffered: above the 8 MiB high-water mark, so writes must queue.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.connections.add(connection);

    const total = 25;
    for (let i = 1; i <= total; i += 1) {
      gateway.broadcastEvent("node.started", {
        runId: "run-writer",
        nodeId: `n${i}`,
        state: "started",
        iteration: 0,
      });
    }

    // Nothing hit the socket while congested — the pre-fix behavior was to
    // ws.send every generic copy regardless of bufferedAmount.
    expect(connection.sent).toHaveLength(0);
    // Every frame is retained in the bounded writer (no silent drop) and its
    // buffered bytes are observable.
    const writer = connection.eventWriter;
    expect(writer.queue).toHaveLength(total);
    expect(writer.queuedBytes).toBeGreaterThan(0);
    expect(writer.queuedBytes).toBeLessThanOrEqual(QUEUE_MAX_BYTES);
    expect(gateway.getConnectionBufferedEventBytes(connection)).toBe(16 * 1024 * 1024 + writer.queuedBytes);

    // Socket recovers: the retry loop drains the whole backlog in order.
    connection.ws.bufferedAmount = 0;
    await sleep(60);

    const events = connection.sent.filter((frame) => frame.event === "node.started");
    expect(events).toHaveLength(total);
    expect(events.map((frame) => frame.payload.nodeId)).toEqual(
      Array.from({ length: total }, (_value, index) => `n${index + 1}`),
    );
    // One writer: connection seq is contiguous in actual send order.
    expect(connection.sent.map((frame) => frame.seq)).toEqual(
      Array.from({ length: connection.sent.length }, (_value, index) => index + 1),
    );
    expect(writer.queue).toHaveLength(0);
    expect(writer.queuedBytes).toBe(0);
  });

  test("a matching run-event stream receives each logical event exactly once", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 0 });
    gateway.connections.add(connection);
    gateway.registerRunEventSubscriber(connection, "stream-shared", "run-shared");

    const healthy = 10;
    for (let i = 1; i <= healthy; i += 1) {
      gateway.broadcastEvent("node.started", {
        runId: "run-shared",
        nodeId: `n${i}`,
        state: "started",
        iteration: 0,
      });
    }
    await sleep(20);

    expect(connection.sent.filter((frame) => frame.event === "node.started")).toHaveLength(0);
    expect(connection.sent.filter((frame) => frame.event === "run.event")).toHaveLength(healthy);
    expect(connection.sent.map((frame) => frame.payload.payload.nodeId)).toEqual(
      Array.from({ length: healthy }, (_value, index) => `n${index + 1}`),
    );

    // Congest the socket: the single dedicated copy stops hitting ws.send and
    // buffers in the stream's bounded queue.
    const alreadySent = connection.sent.length;
    connection.ws.bufferedAmount = 16 * 1024 * 1024;
    const congested = 15;
    for (let i = 1; i <= congested; i += 1) {
      gateway.broadcastEvent("node.started", {
        runId: "run-shared",
        nodeId: `c${i}`,
        state: "started",
        iteration: 0,
      });
    }
    expect(connection.sent).toHaveLength(alreadySent);
    expect(connection.eventWriter.queue).toHaveLength(0);
    const stream = connection.runEventStreams.get("stream-shared");
    expect(stream.outboundQueue).toHaveLength(congested);

    // Recovery flushes the single copy through the connection writer.
    connection.ws.bufferedAmount = 0;
    await sleep(80);
    expect(
      connection.sent.filter((frame) => frame.event === "node.started" && frame.payload.nodeId.startsWith("c")),
    ).toHaveLength(0);
    expect(
      connection.sent.filter((frame) => frame.event === "run.event" && frame.payload.payload.nodeId.startsWith("c")),
    ).toHaveLength(congested);
    const seqs = connection.sent.filter((frame) => frame.event !== "run.heartbeat").map((frame) => frame.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(connection.eventWriter.queue).toHaveLength(0);
    expect(connection.eventWriter.queuedBytes).toBe(0);
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("run filtering still applies before choosing the dedicated delivery path", () => {
    gateway = new Gateway({});
    connection = makeFakeConnection();
    connection.subscribedRuns = new Set(["run-allowed"]);
    gateway.connections.add(connection);
    gateway.registerRunEventSubscriber(connection, "stream-blocked", "run-blocked");

    gateway.broadcastEvent("node.started", {
      runId: "run-blocked",
      nodeId: "blocked",
      state: "started",
      iteration: 0,
    });
    gateway.broadcastEvent("node.started", {
      runId: "run-allowed",
      nodeId: "allowed",
      state: "started",
      iteration: 0,
    });

    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0].event).toBe("node.started");
    expect(connection.sent[0].payload.nodeId).toBe("allowed");
    expect(connection.runEventStreams.get("stream-blocked").outboundQueue).toHaveLength(0);
  });

  test("live events remain queued behind replay without a generic duplicate", () => {
    gateway = new Gateway({});
    gateway.broadcastEvent("node.started", {
      runId: "run-replay",
      nodeId: "replayed",
      state: "started",
      iteration: 0,
    });
    connection = makeFakeConnection();
    gateway.connections.add(connection);
    gateway.registerRunEventSubscriber(connection, "stream-replay", "run-replay", true);

    gateway.broadcastEvent("node.started", {
      runId: "run-replay",
      nodeId: "live",
      state: "started",
      iteration: 0,
    });

    const stream = connection.runEventStreams.get("stream-replay");
    expect(connection.sent).toHaveLength(0);
    expect(stream.outboundQueue).toHaveLength(1);

    const replayFrame = gateway.runEventWindows.get("run-replay").window[0];
    gateway.sendRunEventStreamFrame(connection, "stream-replay", replayFrame, true);
    stream.replayPending = false;
    gateway.drainRunEventStream(connection, stream);

    expect(connection.sent.map((frame) => frame.event)).toEqual(["run.event", "run.event"]);
    expect(connection.sent.map((frame) => frame.payload.payload.nodeId)).toEqual(["replayed", "live"]);
    expect(connection.sent.map((frame) => frame.payload.seq)).toEqual([1, 2]);
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("responses and events share one ordered queue while the socket is congested", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });

    gateway.sendResponse(connection, { type: "res", id: "first", ok: true, payload: { value: 1 } });
    gateway.sendEvent(connection, "run.heartbeat", { streamId: "stream-1" });
    gateway.sendResponse(connection, {
      type: "res",
      id: "second",
      ok: false,
      error: { code: "Internal", message: "failed" },
    });

    expect(connection.sent).toHaveLength(0);
    expect(connection.eventWriter.queue.map((entry) => JSON.parse(entry.data).type)).toEqual(["res", "event", "res"]);
    expect(connection.eventWriter.queuedBytes).toBeGreaterThan(0);

    connection.ws.bufferedAmount = 0;
    await sleep(60);

    expect(connection.sent.map((frame) => (frame.type === "res" ? frame.id : frame.event))).toEqual([
      "first",
      "run.heartbeat",
      "second",
    ]);
    expect(connection.eventWriter.queue).toHaveLength(0);
    expect(connection.eventWriter.queuedBytes).toBe(0);
  });

  test("keeps one drain retry pending while more frames arrive on a congested connection", () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });

    const nativeSetTimeout = globalThis.setTimeout;
    const drainRetries = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 10) {
        drainRetries.push(() => callback(...args));
        return /** @type {ReturnType<typeof setTimeout>} */ ({});
      }
      return nativeSetTimeout(callback, delay, ...args);
    };

    try {
      for (let index = 0; index < 20; index += 1) {
        gateway.sendEvent(connection, "node.started", { index });
      }

      expect(connection.eventWriter.queue).toHaveLength(20);
      expect(connection.eventWriter.flushPending).toBe(true);
      expect(drainRetries).toHaveLength(1);

      connection.ws.bufferedAmount = 0;
      drainRetries[0]();

      expect(connection.sent).toHaveLength(20);
      expect(connection.eventWriter.queue).toHaveLength(0);
      expect(connection.eventWriter.flushPending).toBe(false);
      expect(drainRetries).toHaveLength(1);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("rejects a response that would exceed the queued byte budget before ws.send", () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    const writer = gateway.getConnectionEventWriter(connection);
    writer.queuedBytes = QUEUE_MAX_BYTES - 1;

    gateway.sendResponse(connection, {
      type: "res",
      id: "oversized",
      ok: true,
      payload: { chunk: "small" },
    });

    expect(connection.sent).toHaveLength(0);
    expect(writer.disconnected).toBe(true);
    expect(writer.queuedBytes).toBe(0);
    expect(connection.closes).toEqual([{ code: BACKPRESSURE_CLOSE_CODE, reason: "event backpressure" }]);
  });

  test("sends one oversized response immediately when the socket is healthy", () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 0 });

    gateway.sendResponse(connection, {
      type: "res",
      id: "large-response",
      ok: true,
      payload: { chunk: "x".repeat(QUEUE_MAX_BYTES + 1) },
    });

    expect(connection.sent).toHaveLength(1);
    expect(connection.sent[0].id).toBe("large-response");
    expect(connection.eventWriter.queuedBytes).toBe(0);
    expect(connection.closes).toEqual([]);
  });

  test("overflowing the byte-bounded writer disconnects the connection (close 1013)", async () => {
    gateway = new Gateway({});
    // Permanently congested socket: drains never make progress.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.connections.add(connection);

    const writer = gateway.getConnectionEventWriter(connection);
    writer.queuedBytes = QUEUE_MAX_BYTES - 1;
    gateway.broadcastEvent("node.started", {
      runId: "run-overflow",
      nodeId: "n1",
      state: "started",
      iteration: 0,
    });

    // Nothing ever bypassed onto the congested socket.
    expect(connection.sent).toHaveLength(0);
    // Per-connection failure behavior: buffer dropped, socket closed 1013.
    expect(writer.disconnected).toBe(true);
    expect(writer.queue).toHaveLength(0);
    expect(writer.queuedBytes).toBe(0);
    expect(connection.closes).toHaveLength(1);
    expect(connection.closes[0].code).toBe(BACKPRESSURE_CLOSE_CODE);

    // Further broadcasts buffer nothing for the dead connection.
    gateway.broadcastEvent("node.started", {
      runId: "run-overflow",
      nodeId: "after-disconnect",
      state: "started",
      iteration: 0,
    });
    expect(connection.sent).toHaveLength(0);
    expect(connection.eventWriter.queue).toHaveLength(0);

    // Let the fire-and-forget metric effect flush, then assert it surfaced.
    await sleep(20);
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain("smithers_gateway_run_event_backpressure_disconnect_total");
  });
});

function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway did not expose a port");
  }
  return address.port;
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("a paused real WebSocket is disconnected when its shared writer reaches the byte cap", async () => {
  const gateway = new Gateway({ heartbeatMs: 60_000 });
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const socket = connectTcp({ host: "127.0.0.1", port: getPort(server) });
  socket.on("error", () => {});

  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const handshake = new Promise((resolve, reject) => {
      let response = "";
      const onData = (chunk) => {
        response += chunk.toString("latin1");
        if (!response.includes("\r\n\r\n")) {
          return;
        }
        socket.off("data", onData);
        if (!response.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WebSocket upgrade failed: ${response.slice(0, 80)}`));
          return;
        }
        resolve();
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${getPort(server)}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "",
        "",
      ].join("\r\n"),
    );
    await handshake;
    await waitUntil(() => gateway.connections.size === 1, "server WebSocket connection");

    const connection = [...gateway.connections][0];
    const writer = gateway.getConnectionEventWriter(connection);
    socket.pause();
    Object.defineProperty(connection.ws, "bufferedAmount", {
      configurable: true,
      value: 16 * 1024 * 1024,
    });
    writer.queuedBytes = QUEUE_MAX_BYTES - 512;

    gateway.sendResponse(connection, {
      type: "res",
      id: "slow-response",
      ok: true,
      payload: { value: 1 },
    });
    expect(writer.queue.map((entry) => JSON.parse(entry.data).type)).toEqual(["res"]);

    gateway.sendEvent(connection, "run.event", {
      runId: "slow-run",
      chunk: "x".repeat(1024),
    });

    expect(writer.disconnected).toBe(true);
    expect(writer.queue).toHaveLength(0);
    expect(writer.queuedBytes).toBe(0);
    expect(connection.ws.readyState).not.toBe(connection.ws.OPEN);
  } finally {
    socket.destroy();
    await gateway.close();
  }
}, 20_000);
