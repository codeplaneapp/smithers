import { afterEach, describe, expect, test } from "bun:test";
import { renderPrometheusMetrics } from "@smithers-orchestrator/observability";
import { Gateway } from "../src/gateway.js";

// streamRunEvents fans live frames straight onto the WS socket. These tests
// drive sendRunEventStreamFrame directly against a fake connection whose
// bufferedAmount we control, so we can prove the per-stream outbound queue is
// bounded, that a congested socket buffers without loss, and that a slow
// consumer that overflows the queue is disconnected (run.error) instead of
// wedging the server with unbounded buffering.

// Mirrors RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT in src/gateway.js.
const QUEUE_LIMIT = 1_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeConnection({ bufferedAmount = 0 } = {}) {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
  return {
    id: "conn-bp",
    connectionId: "conn-bp",
    role: "operator",
    scopes: ["*"],
    userId: "user:bp",
    authenticated: true,
    seq: 0,
    ws,
    sent,
    runEventStreams: undefined,
  };
}

function runEvents(connection) {
  return connection.sent.filter((frame) => frame.event === "run.event");
}

function runErrors(connection) {
  return connection.sent.filter((frame) => frame.event === "run.error");
}

describe("streamRunEvents backpressure", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {ReturnType<typeof makeFakeConnection> | undefined} */
  let connection;

  afterEach(() => {
    if (gateway && connection) {
      gateway.cleanupRunEventSubscribers(connection);
    }
    gateway = undefined;
    connection = undefined;
  });

  test("delivers a large burst in order on a healthy socket without disconnecting", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 0 });
    gateway.registerRunEventSubscriber(connection, "stream-burst", "run-burst");

    const burst = 800;
    for (let seq = 1; seq <= burst; seq += 1) {
      gateway.sendRunEventStreamFrame(connection, "stream-burst", {
        runId: "run-burst",
        seq,
        event: "node.started",
      });
    }
    await sleep(20);

    const events = runEvents(connection);
    expect(events).toHaveLength(burst);
    expect(events.map((frame) => frame.payload.seq)).toEqual(
      Array.from({ length: burst }, (_value, index) => index + 1),
    );
    expect(runErrors(connection)).toHaveLength(0);
    // Subscriber survives; queue fully drained.
    const stream = connection.runEventStreams.get("stream-burst");
    expect(stream.backpressureDisconnected).toBe(false);
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("does not misclassify a healthy replay burst larger than the queue limit as backpressure", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection({ bufferedAmount: 0 });
    gateway.registerRunEventSubscriber(connection, "stream-replay", "run-replay");

    const burst = QUEUE_LIMIT + 500;
    for (let seq = 1; seq <= burst; seq += 1) {
      gateway.sendRunEventStreamFrame(connection, "stream-replay", {
        runId: "run-replay",
        seq,
        event: "node.started",
      });
    }

    const events = runEvents(connection);
    expect(events).toHaveLength(burst);
    expect(events[0].payload.seq).toBe(1);
    expect(events[events.length - 1].payload.seq).toBe(burst);
    expect(runErrors(connection)).toHaveLength(0);
    const stream = connection.runEventStreams.get("stream-replay");
    expect(stream.backpressureDisconnected).toBe(false);
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("buffers frames while the socket is congested then drains them losslessly", async () => {
    gateway = new Gateway({});
    // 16 MiB buffered: above the 8 MiB high-water mark, so drains stall.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.registerRunEventSubscriber(connection, "stream-congested", "run-congested");

    const queued = 50;
    for (let seq = 1; seq <= queued; seq += 1) {
      gateway.sendRunEventStreamFrame(connection, "stream-congested", {
        runId: "run-congested",
        seq,
        event: "node.started",
      });
    }
    await sleep(30);

    // Nothing delivered while congested, but every frame is retained (bounded
    // buffer, no silent drop).
    expect(runEvents(connection)).toHaveLength(0);
    const stream = connection.runEventStreams.get("stream-congested");
    expect(stream.outboundQueue).toHaveLength(queued);
    expect(stream.backpressureDisconnected).toBe(false);

    // Socket recovers: the retry loop drains the whole backlog in order.
    connection.ws.bufferedAmount = 0;
    await sleep(60);

    const events = runEvents(connection);
    expect(events).toHaveLength(queued);
    expect(events.map((frame) => frame.payload.seq)).toEqual(
      Array.from({ length: queued }, (_value, index) => index + 1),
    );
    expect(stream.outboundQueue).toHaveLength(0);
  });

  test("disconnects a slow consumer once the outbound queue overflows", async () => {
    gateway = new Gateway({});
    // Permanently congested socket: drains never make progress.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.registerRunEventSubscriber(connection, "stream-slow", "run-slow");

    let disconnectedAt = 0;
    for (let seq = 1; seq <= QUEUE_LIMIT + 1; seq += 1) {
      gateway.sendRunEventStreamFrame(connection, "stream-slow", {
        runId: "run-slow",
        seq,
        event: "node.started",
      });
      if (!connection.runEventStreams.has("stream-slow") && disconnectedAt === 0) {
        disconnectedAt = seq;
      }
    }

    // The (limit+1)th frame trips the disconnect.
    expect(disconnectedAt).toBe(QUEUE_LIMIT + 1);
    const errors = runErrors(connection);
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.error.code).toBe("BackpressureDisconnect");
    expect(errors[0].payload.runId).toBe("run-slow");
    // Subscriber torn down; only this stream, the WS stays usable.
    expect(connection.runEventStreams.has("stream-slow")).toBe(false);

    // Let the fire-and-forget metric effect flush, then assert it surfaced.
    await sleep(20);
    const metrics = renderPrometheusMetrics();
    expect(metrics).toContain("smithers_gateway_run_event_backpressure_disconnect_total");
  });
});
