// Regression coverage for #553: streamRunEvents, streamDevTools, and
// subscribeExtensionStream each register their subscription *after* an
// `await`. If the WS closes while that await is in flight, the close path's
// cleanup*Subscribers already ran for this connection before the handler
// gets back control — registering afterward would leak a subscriber that no
// future cleanup call will ever see again. These tests drive that race
// directly via `gateway.routeRequest`, mirroring the fake-connection pattern
// used in gateway-extensions-dispatch.test.js.
import { describe, expect, test } from "bun:test";
import { Gateway } from "../src/index.js";

function fakeConnection({ scopes = ["*"], transport = "ws" } = {}) {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
  };
  return {
    connection: {
      transport,
      ws,
      authenticated: true,
      scopes,
      seq: 0,
      role: "operator",
      userId: "user:test",
      tokenId: "tok",
      connectionId: "conn",
      closed: false,
    },
    sent,
  };
}

function frame(method, params = {}) {
  return { type: "req", id: "1", method, params };
}

describe("gateway subscribe-after-await close race (#553)", () => {
  test("streamRunEvents does not register a subscriber if the connection closed mid-resolveRun", async () => {
    const gateway = new Gateway();
    let releaseResolve;
    const resolveBarrier = new Promise((resolve) => { releaseResolve = resolve; });
    gateway.resolveRun = async () => {
      await resolveBarrier;
      return { workflowKey: "wf", workflow: {}, adapter: {} };
    };
    const { connection } = fakeConnection();
    const pending = gateway.routeRequest(connection, frame("streamRunEvents", { runId: "run-1" }));
    // Simulate the close path: it already ran cleanupRunEventSubscribers for
    // this connection before resolveRun's await settles.
    connection.closed = true;
    releaseResolve();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("ConnectionClosed");
    expect(gateway.getRunEventSubscriberCount("run-1")).toBe(0);
    expect(connection.runEventStreams?.size ?? 0).toBe(0);
  });

  test("streamDevTools does not register a subscriber if the connection closed mid-resolveRun", async () => {
    const gateway = new Gateway();
    let releaseResolve;
    const resolveBarrier = new Promise((resolve) => { releaseResolve = resolve; });
    gateway.resolveRun = async () => {
      await resolveBarrier;
      return { workflowKey: "wf", workflow: {}, adapter: { getLastFrame: async () => null } };
    };
    const { connection } = fakeConnection();
    const pending = gateway.routeRequest(connection, frame("streamDevTools", { runId: "run-1" }));
    connection.closed = true;
    releaseResolve();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("ConnectionClosed");
    expect(gateway.devtoolsSubscribers.size).toBe(0);
    expect(connection.devtoolsStreams?.size ?? 0).toBe(0);
  });

  test("subscribeExtensionStream aborts and cleans up if the connection closed mid-subscribe", async () => {
    const gateway = new Gateway();
    let cleanedUp = false;
    let streamCtx;
    let releaseSubscribe;
    const subscribeBarrier = new Promise((resolve) => { releaseSubscribe = resolve; });
    gateway.extend("logs", {
      streams: {
        tail: {
          subscribe: async (_params, ctx) => {
            streamCtx = ctx;
            await subscribeBarrier;
            return { initial: { snapshot: [] }, cleanup: () => { cleanedUp = true; } };
          },
        },
      },
    });
    const { connection } = fakeConnection();
    const pending = gateway.routeRequest(connection, frame("ext.stream.logs.tail"));
    // Simulate the close path: it already ran cleanupExtensionSubscriptions
    // for this connection (a no-op here since nothing is registered yet).
    connection.closed = true;
    releaseSubscribe();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("ConnectionClosed");
    // The AbortController must fire so handler-side work gated on ctx.signal
    // stops — the never-aborted signal is the leak #553 describes.
    expect(streamCtx.signal.aborted).toBe(true);
    expect(cleanedUp).toBe(true);
    expect(gateway.extensionStreamSubscriptions.has(connection)).toBe(false);
  });
});
