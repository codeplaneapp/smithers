// streamRunEvents cap coverage uses the same direct routeRequest harness as
// gateway-stream-close-race.test.js. Each rejection is observed on the RPC
// response frame, while fake connections make the stream map, heartbeat, and
// subscriber counters directly inspectable.
import { afterEach, describe, expect, test } from "bun:test";
import { Gateway } from "../src/gateway.js";

/** @type {Array<{ gateway: Gateway; connections: Record<string, any>[] }>} */
const harnesses = [];

afterEach(async () => {
  for (const { gateway, connections } of harnesses.splice(0).reverse()) {
    for (const connection of connections) {
      gateway.cleanupRunEventSubscribers(connection);
    }
    try {
      await gateway.close();
    } catch {}
  }
});

function fakeConnection(connectionId, userId) {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close() {
      this.readyState = 3;
    },
  };
  return {
    transport: "ws",
    ws,
    authenticated: true,
    scopes: ["*"],
    seq: 0,
    role: "operator",
    userId,
    tokenId: `token:${userId}`,
    connectionId,
    closed: false,
    runEventStreams: undefined,
    runEventHeartbeatTimer: null,
    sent,
  };
}

function createHarness() {
  const gateway = new Gateway();
  gateway.resolveRun = async () => ({ workflowKey: "wf", workflow: {}, adapter: {} });
  const connections = [];
  harnesses.push({ gateway, connections });
  return {
    gateway,
    connection(connectionId, userId) {
      const connection = fakeConnection(connectionId, userId);
      connections.push(connection);
      return connection;
    },
  };
}

function requestFrame(id, runId) {
  return { type: "req", id, method: "streamRunEvents", params: { runId } };
}

async function subscribe(gateway, connection, runId) {
  const response = await gateway.routeRequest(
    connection,
    requestFrame(`subscribe-${connection.connectionId}-${runId}`, runId),
  );
  expect(response.ok).toBe(true);
  return response.payload.streamId;
}

function configureOnlyCap(gateway, scope, limit) {
  gateway.runEventStreamMaxSubscribers = 100;
  gateway.runEventStreamMaxSubscribersPerUser = 100;
  gateway.runEventStreamMaxSubscribersPerConnection = 100;
  gateway.runEventStreamMaxSubscribersPerRun = 100;
  if (scope === "global") gateway.runEventStreamMaxSubscribers = limit;
  if (scope === "user") gateway.runEventStreamMaxSubscribersPerUser = limit;
  if (scope === "connection") gateway.runEventStreamMaxSubscribersPerConnection = limit;
  if (scope === "run") gateway.runEventStreamMaxSubscribersPerRun = limit;
}

function subscriberState(gateway, connection) {
  return {
    total: gateway.runEventSubscriberTotal,
    byUser: [...gateway.runEventSubscribersByUser.entries()].sort(),
    byRun: [...gateway.runEventSubscriberCounts.entries()].sort(),
    connectionStreams: connection.runEventStreams?.size ?? 0,
  };
}

async function expectCapRejection(gateway, connection, runId, scope, limit) {
  const before = subscriberState(gateway, connection);
  const heartbeatBefore = connection.runEventHeartbeatTimer;
  const response = await gateway.routeRequest(
    connection,
    requestFrame(`reject-${scope}-${connection.connectionId}`, runId),
  );

  expect(response).toMatchObject({
    type: "res",
    ok: false,
    error: {
      code: "RateLimited",
      scope,
      limit,
    },
  });
  // The rejected registration owns nothing: no stream entry, heartbeat, or
  // counter changes. An existing connection heartbeat must stay the same one.
  expect(subscriberState(gateway, connection)).toEqual(before);
  expect(connection.runEventHeartbeatTimer).toBe(heartbeatBefore);
}

describe("streamRunEvents subscriber caps", () => {
  test("per-connection cap allows a few multiplexed runs and rejects before allocation", async () => {
    const { gateway, connection } = createHarness();
    expect({
      global: gateway.runEventStreamMaxSubscribers,
      user: gateway.runEventStreamMaxSubscribersPerUser,
      connection: gateway.runEventStreamMaxSubscribersPerConnection,
      run: gateway.runEventStreamMaxSubscribersPerRun,
    }).toEqual({ global: 256, user: 32, connection: 8, run: 64 });
    configureOnlyCap(gateway, "connection", 2);
    const client = connection("conn-a", "user:a");

    await subscribe(gateway, client, "run-a");
    await subscribe(gateway, client, "run-b");
    const heartbeat = client.runEventHeartbeatTimer;
    expect(heartbeat).toBeTruthy();

    await expectCapRejection(gateway, client, "run-c", "connection", 2);
    expect(client.runEventStreams.size).toBe(2);
    expect(client.runEventHeartbeatTimer).toBe(heartbeat);
  });

  test("per-user cap spans connections without blocking another identity", async () => {
    const { gateway, connection } = createHarness();
    configureOnlyCap(gateway, "user", 2);
    const first = connection("conn-user-a-1", "user:a");
    const second = connection("conn-user-a-2", "user:a");
    const rejected = connection("conn-user-a-3", "user:a");

    await subscribe(gateway, first, "run-a");
    await subscribe(gateway, second, "run-b");
    await expectCapRejection(gateway, rejected, "run-c", "user", 2);
    expect(rejected.runEventStreams).toBeUndefined();
    expect(rejected.runEventHeartbeatTimer).toBeNull();

    const otherUser = connection("conn-user-b", "user:b");
    await subscribe(gateway, otherUser, "run-c");
    expect(gateway.runEventSubscribersByUser.get("user:b")).toBe(1);
  });

  test("per-run cap bounds hot-run fanout without blocking another run", async () => {
    const { gateway, connection } = createHarness();
    configureOnlyCap(gateway, "run", 2);
    const first = connection("conn-run-1", "user:a");
    const second = connection("conn-run-2", "user:b");
    const rejected = connection("conn-run-3", "user:c");

    await subscribe(gateway, first, "hot-run");
    await subscribe(gateway, second, "hot-run");
    await expectCapRejection(gateway, rejected, "hot-run", "run", 2);
    expect(rejected.runEventStreams).toBeUndefined();
    expect(gateway.getRunEventSubscriberCount("hot-run")).toBe(2);

    await subscribe(gateway, rejected, "other-run");
    expect(gateway.getRunEventSubscriberCount("other-run")).toBe(1);
  });

  test("gateway-wide cap rejects a different user, connection, and run without allocation", async () => {
    const { gateway, connection } = createHarness();
    configureOnlyCap(gateway, "global", 2);
    await subscribe(gateway, connection("conn-global-1", "user:a"), "run-a");
    await subscribe(gateway, connection("conn-global-2", "user:b"), "run-b");
    const rejected = connection("conn-global-3", "user:c");

    await expectCapRejection(gateway, rejected, "run-c", "global", 2);
    expect(rejected.runEventStreams).toBeUndefined();
    expect(rejected.runEventHeartbeatTimer).toBeNull();
    expect(gateway.runEventSubscriberTotal).toBe(2);
  });
});
