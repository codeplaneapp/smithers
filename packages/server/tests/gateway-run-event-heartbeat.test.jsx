/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Gateway } from "../src/gateway.js";

// Each registered run event stream used to arm its own 1s heartbeat interval,
// so N streams on one WebSocket meant N timers. These tests prove a connection
// now owns AT MOST ONE shared heartbeat timer: it starts with the first
// registered stream, emits per-stream `run.heartbeat` frames with the required
// payload, survives while any stream remains, and is torn down on the last
// unsubscribe, on backpressure disconnect, on socket close, and on gateway
// shutdown.

// Mirrors RUN_EVENT_STREAM_OUTBOUND_QUEUE_LIMIT in src/gateway.js.
const QUEUE_LIMIT = 1_000;
// Mirrors RUN_EVENT_HEARTBEAT_MS in src/gateway.js.
const HEARTBEAT_MS = 1_000;

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
    close() {},
  };
  return {
    id: "conn-hb",
    connectionId: "conn-hb",
    role: "operator",
    scopes: ["*"],
    userId: "user:hb",
    authenticated: true,
    seq: 0,
    ws,
    sent,
    runEventStreams: undefined,
    runEventHeartbeatTimer: null,
  };
}

function heartbeats(connection, streamId) {
  return connection.sent.filter(
    (frame) => frame.event === "run.heartbeat" && (streamId === undefined || frame.payload.streamId === streamId),
  );
}

function expectNoRunEventSubscribers(gateway, connection) {
  expect(connection.runEventStreams?.size ?? 0).toBe(0);
  expect(gateway.runEventSubscriberTotal).toBe(0);
  expect(gateway.runEventSubscribersByUser.size).toBe(0);
  expect(gateway.runEventSubscriberCounts.size).toBe(0);
}

describe("run event stream shared heartbeat", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {ReturnType<typeof makeFakeConnection> | undefined} */
  let connection;

  afterEach(async () => {
    if (gateway && connection) {
      gateway.cleanupRunEventSubscribers(connection);
    }
    try {
      await gateway?.close?.();
    } catch {}
    gateway = undefined;
    connection = undefined;
  });

  test("shares one timer across streams and emits per-stream heartbeats with the required payload", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection();

    gateway.registerRunEventSubscriber(connection, "stream-a", "run-1");
    const timer = connection.runEventHeartbeatTimer;
    expect(timer).toBeTruthy();

    gateway.registerRunEventSubscriber(connection, "stream-b", "run-1");
    gateway.registerRunEventSubscriber(connection, "stream-c", "run-2");
    // Registering more streams re-uses the connection's single timer.
    expect(connection.runEventHeartbeatTimer).toBe(timer);
    expect(connection.runEventStreams.size).toBe(3);
    expect(gateway.runEventSubscriberTotal).toBe(3);
    expect(gateway.runEventSubscribersByUser.get("user:hb")).toBe(3);
    expect(gateway.getRunEventSubscriberCount("run-1")).toBe(2);
    expect(gateway.getRunEventSubscriberCount("run-2")).toBe(1);

    // Let the shared timer tick at least once.
    await sleep(HEARTBEAT_MS + 400);

    for (const [streamId, runId] of [
      ["stream-a", "run-1"],
      ["stream-b", "run-1"],
      ["stream-c", "run-2"],
    ]) {
      const frames = heartbeats(connection, streamId);
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const payload = frames[0].payload;
      expect(payload.type).toBe("Heartbeat");
      expect(typeof payload.apiVersion).toBe("string");
      expect(payload.streamId).toBe(streamId);
      expect(payload.runId).toBe(runId);
      expect(typeof payload.ts).toBe("number");
    }

    // One shared timer: every tick fans out exactly one heartbeat per stream,
    // so all streams see the same number of heartbeats.
    const counts = ["stream-a", "stream-b", "stream-c"].map((streamId) => heartbeats(connection, streamId).length);
    expect(new Set(counts).size).toBe(1);
  });

  test("keeps the timer until the last stream unregisters, then stops it", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection();

    gateway.registerRunEventSubscriber(connection, "stream-first", "run-first");
    const unsubscribeSecond = gateway.registerRunEventSubscriber(connection, "stream-second", "run-second");
    const timer = connection.runEventHeartbeatTimer;
    expect(timer).toBeTruthy();

    gateway.unregisterRunEventSubscriber(connection, "stream-first");
    // A stream remains, so the shared timer must keep running.
    expect(connection.runEventHeartbeatTimer).toBe(timer);
    expect(gateway.runEventSubscriberTotal).toBe(1);
    expect(gateway.runEventSubscribersByUser.get("user:hb")).toBe(1);
    expect(gateway.getRunEventSubscriberCount("run-first")).toBe(0);
    expect(gateway.getRunEventSubscriberCount("run-second")).toBe(1);

    unsubscribeSecond();
    expectNoRunEventSubscribers(gateway, connection);
    expect(connection.runEventHeartbeatTimer).toBeNull();

    // No orphaned interval keeps firing after the last unsubscribe.
    const heartbeatsBefore = heartbeats(connection).length;
    await sleep(HEARTBEAT_MS + 400);
    expect(heartbeats(connection).length).toBe(heartbeatsBefore);
  });

  test("stops the timer when the last stream is disconnected for backpressure", () => {
    gateway = new Gateway({});
    // Permanently congested socket: drains never make progress.
    connection = makeFakeConnection({ bufferedAmount: 16 * 1024 * 1024 });
    gateway.registerRunEventSubscriber(connection, "stream-slow", "run-slow");
    expect(connection.runEventHeartbeatTimer).toBeTruthy();

    for (let seq = 1; seq <= QUEUE_LIMIT + 1; seq += 1) {
      gateway.sendRunEventStreamFrame(connection, "stream-slow", {
        runId: "run-slow",
        seq,
        event: "node.started",
      });
    }

    // On a congested socket the run.error frame goes through the bounded
    // connection event writer instead of an immediate ws.send, so it lands in
    // the writer queue until the socket drains.
    const queuedErrors = (connection.eventWriter?.queue ?? [])
      .map((entry) => JSON.parse(entry.data))
      .filter((frame) => frame.event === "run.error");
    const sentErrors = connection.sent.filter((frame) => frame.event === "run.error");
    const errors = [...sentErrors, ...queuedErrors];
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.error.code).toBe("BackpressureDisconnect");
    expect(connection.runEventStreams.has("stream-slow")).toBe(false);
    expect(connection.runEventHeartbeatTimer).toBeNull();
    expectNoRunEventSubscribers(gateway, connection);
  });

  test("clears the timer via the socket-close cleanup path", () => {
    gateway = new Gateway({});
    connection = makeFakeConnection();
    gateway.registerRunEventSubscriber(connection, "stream-x", "run-x");
    gateway.registerRunEventSubscriber(connection, "stream-y", "run-y");
    expect(connection.runEventHeartbeatTimer).toBeTruthy();

    // This is exactly what the ws "close"/"error" handler invokes.
    gateway.cleanupRunEventSubscribers(connection);

    expectNoRunEventSubscribers(gateway, connection);
    expect(connection.runEventHeartbeatTimer).toBeNull();
  });

  test("clears the timer on gateway shutdown even with streams still registered", async () => {
    gateway = new Gateway({});
    connection = makeFakeConnection();
    gateway.connections.add(connection);
    gateway.registerRunEventSubscriber(connection, "stream-open", "run-open");
    expect(connection.runEventHeartbeatTimer).toBeTruthy();

    await gateway.close();

    expect(connection.runEventHeartbeatTimer).toBeNull();
    expectNoRunEventSubscribers(gateway, connection);
    gateway = undefined;
    connection = undefined;
  });
});

// Real-gateway coverage: two streamRunEvents subscriptions over one real
// WebSocket share a single server-side heartbeat timer, both receive
// heartbeats over the wire, and closing the socket tears the timer down.

const AUTH_TOKENS = {
  "op-token": { role: "operator", scopes: ["*"], userId: "user:test" },
};

function makeDbPath(name) {
  return join(tmpdir(), `smithers-run-event-heartbeat-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

function createHeartbeatWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ out: z.object({ value: z.number() }) }, { dbPath });
  return smithers(() => (
    <Workflow name="heartbeat">
      <Task id="a" output={outputs.out}>
        {{ value: 1 }}
      </Task>
    </Workflow>
  ));
}

class GatewayClient {
  messages = [];

  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(String(raw)));
    });
  }

  async waitFor(predicate, timeoutMs = 5_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await sleep(10);
    }
    throw new Error(`Timed out waiting for gateway message: ${JSON.stringify(this.messages)}`);
  }

  async request(method, params) {
    const id = `${method}-${Math.random().toString(36).slice(2)}`;
    this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    return this.waitFor((message) => message.type === "res" && message.id === id);
  }

  async close() {
    if (this.ws.readyState === this.ws.CLOSED) {
      return;
    }
    await new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function connectGateway(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const client = new GatewayClient(ws);
  await client.waitFor((message) => message.type === "event" && message.event === "connect.challenge");
  const hello = await client.request("connect", {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "run-event-heartbeat-test", version: "1.0.0", platform: "bun-test" },
    auth: { token },
  });
  expect(hello.ok).toBe(true);
  return client;
}

describe("run event stream shared heartbeat over a real socket", () => {
  /** @type {Gateway | undefined} */
  let gateway;
  /** @type {string[]} */
  let dbPaths = [];

  afterEach(async () => {
    try {
      await gateway?.close?.();
    } catch {}
    for (const dbPath of dbPaths) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
    gateway = undefined;
    dbPaths = [];
  });

  test("two subscriptions share one timer, both stream heartbeats, and socket close stops it", async () => {
    const dbPath = makeDbPath("socket-close");
    dbPaths.push(dbPath);
    const workflow = createHeartbeatWorkflow(dbPath);
    gateway = new Gateway({
      heartbeatMs: 60_000,
      auth: { mode: "token", tokens: AUTH_TOKENS },
    });
    gateway.register("heartbeat", workflow);
    ensureSmithersTables(workflow.db);
    const adapter = gateway.adapterForWorkflow(workflow);
    const runId = "heartbeat-run";
    await adapter.insertRun({
      runId,
      workflowName: "heartbeat",
      status: "running",
      createdAtMs: Date.now(),
    });

    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const client = await connectGateway(getPort(server), "op-token");

    const first = await client.request("streamRunEvents", { runId });
    expect(first.ok).toBe(true);
    const second = await client.request("streamRunEvents", { runId });
    expect(second.ok).toBe(true);
    const streamIds = [first.payload.streamId, second.payload.streamId];
    expect(new Set(streamIds).size).toBe(2);

    // One WS connection, two streams, exactly one shared heartbeat timer.
    expect(gateway.connections.size).toBe(1);
    const connection = [...gateway.connections][0];
    expect(connection.runEventStreams.size).toBe(2);
    expect(connection.runEventHeartbeatTimer).toBeTruthy();
    expect(gateway.runEventSubscriberTotal).toBe(2);
    expect(gateway.runEventSubscribersByUser.get("user:test")).toBe(2);
    expect(gateway.getRunEventSubscriberCount(runId)).toBe(2);

    // Both streams receive run.heartbeat frames over the wire.
    for (const streamId of streamIds) {
      const frame = await client.waitFor(
        (message) =>
          message.type === "event" && message.event === "run.heartbeat" && message.payload.streamId === streamId,
      );
      expect(frame.payload.type).toBe("Heartbeat");
      expect(frame.payload.runId).toBe(runId);
      expect(typeof frame.payload.ts).toBe("number");
    }

    await client.close();
    await waitUntil(
      () =>
        gateway.connections.size === 0 &&
        connection.runEventHeartbeatTimer === null &&
        gateway.runEventSubscriberTotal === 0,
      "shared heartbeat timer cleanup after socket close",
    );
    expectNoRunEventSubscribers(gateway, connection);
  });
});
