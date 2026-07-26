import { afterEach, describe, expect, test } from "bun:test";
import { renderPrometheusMetrics } from "@smithers-orchestrator/observability";
import { Gateway } from "../src/gateway.js";

// broadcastEvent used to hand the generic copy of every run event straight to
// ws.send while only the dedicated run-event stream frames went through a
// bounded queue, so a slow socket still accumulated unbounded buffering via
// the generic copy. These tests drive the REAL broadcastEvent path against a
// fake connection whose bufferedAmount we control and prove that every
// run-event write now flows through the single per-connection byte-bounded
// writer: nothing bypasses backpressure onto a congested socket, buffered
// bytes stay under the observable cap, and overflowing the byte budget
// disconnects the connection (close 1013 Try Again Later).

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

describe("gateway connection event writer (bounded broadcast delivery)", () => {
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

  test("generic copies and run-event stream frames share the one bounded writer", async () => {
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

    expect(connection.sent.filter((frame) => frame.event === "node.started")).toHaveLength(healthy);
    expect(connection.sent.filter((frame) => frame.event === "run.event")).toHaveLength(healthy);

    // Congest the socket: BOTH copies must stop hitting ws.send and buffer
    // only in bounded structures.
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
    expect(connection.eventWriter.queue).toHaveLength(congested);
    const stream = connection.runEventStreams.get("stream-shared");
    expect(stream.outboundQueue).toHaveLength(congested);

    // Recovery flushes both copies through the same writer: connection seq is
    // contiguous across the full delivery order, so no frame took a side
    // channel around the writer.
    connection.ws.bufferedAmount = 0;
    await sleep(80);
    expect(
      connection.sent.filter((frame) => frame.event === "node.started" && frame.payload.nodeId.startsWith("c")),
    ).toHaveLength(congested);
    expect(
      connection.sent.filter((frame) => frame.event === "run.event" && frame.payload.payload.nodeId.startsWith("c")),
    ).toHaveLength(congested);
    const seqs = connection.sent.filter((frame) => frame.event !== "run.heartbeat").map((frame) => frame.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(connection.eventWriter.queue).toHaveLength(0);
    expect(connection.eventWriter.queuedBytes).toBe(0);
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("overflowing the byte-bounded writer disconnects the connection (close 1013)", async () => {
    gateway = new Gateway({});
    // Permanently congested socket: drains never make progress.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.connections.add(connection);

    const chunk = "x".repeat(1024 * 1024);
    let disconnectedAt = 0;
    let maxQueuedBytes = 0;
    for (let i = 1; i <= 40; i += 1) {
      gateway.broadcastEvent("node.started", {
        runId: "run-overflow",
        nodeId: `n${i}`,
        state: "started",
        iteration: 0,
        chunk,
      });
      maxQueuedBytes = Math.max(maxQueuedBytes, connection.eventWriter?.queuedBytes ?? 0);
      if (connection.eventWriter?.disconnected && disconnectedAt === 0) {
        disconnectedAt = i;
      }
    }

    // ~1 MiB frames against a 32 MiB budget: the writer must trip well before
    // the loop ends, and buffered bytes never exceed the observable cap.
    expect(disconnectedAt).toBeGreaterThan(0);
    expect(disconnectedAt).toBeLessThanOrEqual(34);
    expect(maxQueuedBytes).toBeLessThanOrEqual(QUEUE_MAX_BYTES);
    // Nothing ever bypassed onto the congested socket.
    expect(connection.sent).toHaveLength(0);
    // Per-connection failure behavior: buffer dropped, socket closed 1013.
    expect(connection.eventWriter.disconnected).toBe(true);
    expect(connection.eventWriter.queue).toHaveLength(0);
    expect(connection.eventWriter.queuedBytes).toBe(0);
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
