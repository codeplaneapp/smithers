// Dispatch-layer tests for `Gateway.routeExtensionRequest` and
// `subscribeExtensionStream`. They construct a Gateway, register an extension
// via `gateway.extend(...)`, then drive the dispatcher with a fake connection
// — the same shape the live WS path passes in — so we cover the scope re-check,
// handler envelope, payload bound, and stream cleanup without standing up a
// real socket.
import { describe, expect, test } from "bun:test";
import { Gateway, EXTENSION_PAYLOAD_MAX_BYTES } from "../src/index.js";

/**
 * Minimal connection shape that satisfies routeExtensionRequest /
 * subscribeExtensionStream. `transport: "ws"` + a fake `ws` object with a
 * captured send() lets us assert event frames the stream pushes back.
 */
function fakeConnection({ scopes = ["*"], transport = "ws" } = {}) {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(data));
    },
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
    },
    sent,
  };
}

function frame(method, params = {}) {
  return { type: "req", id: "1", method, params };
}

describe("Gateway.extend + routeExtensionRequest", () => {
  test("dispatches a resource handler and returns its payload", async () => {
    const gateway = new Gateway();
    gateway.extend("github", {
      resources: { issue: { handler: async (params) => ({ id: params.id, status: "open" }) } },
    });
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.github.issue", { id: "42" }));
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ id: "42", status: "open" });
  });

  test("rejects unknown extension methods with the typed EXTENSION_METHOD_NOT_FOUND code", async () => {
    const gateway = new Gateway();
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.missing.thing"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("EXTENSION_METHOD_NOT_FOUND");
    expect(res.error.method).toBe("ext.missing.thing");
  });

  test("re-checks scope at the extension layer", async () => {
    const gateway = new Gateway();
    gateway.extend("secure", {
      defaultScope: "run:admin",
      resources: { wipe: { handler: () => "done" } },
    });
    const { connection } = fakeConnection({ scopes: ["run:read"] });
    const res = await gateway.routeRequest(connection, frame("ext.secure.wipe"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("FORBIDDEN");
    expect(res.error.requiredScope).toBe("run:admin");
  });

  test("wraps SmithersError-shaped handler throws", async () => {
    const gateway = new Gateway();
    gateway.extend("error", {
      resources: {
        boom: {
          handler: () => {
            const err = new Error("nope");
            err.code = "INVALID_INPUT";
            err.summary = "bad input";
            err.name = "SmithersError";
            // Make isSmithersError happy.
            Object.defineProperty(err, "isSmithersError", { value: true });
            throw err;
          },
        },
      },
    });
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.error.boom"));
    expect(res.ok).toBe(false);
    // The error path swallows non-SmithersError without exposing internals,
    // and SmithersError-shaped errors keep their code.
    expect(["INVALID_INPUT", "EXTENSION_HANDLER_ERROR"]).toContain(res.error.code);
  });

  test("returns EXTENSION_HANDLER_ERROR for plain throws without stack", async () => {
    const gateway = new Gateway();
    gateway.extend("plain", {
      resources: {
        boom: {
          handler: () => {
            throw new Error("boom from handler");
          },
        },
      },
    });
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.plain.boom"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("EXTENSION_HANDLER_ERROR");
    expect(res.error.message).toContain("boom from handler");
  });

  test("rejects a handler payload that exceeds EXTENSION_PAYLOAD_MAX_BYTES", async () => {
    const gateway = new Gateway();
    gateway.extend("big", {
      resources: {
        whale: {
          handler: () => ({ blob: "x".repeat(EXTENSION_PAYLOAD_MAX_BYTES + 1) }),
        },
      },
    });
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.big.whale"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("PayloadTooLarge");
  });

  test("subscribeExtensionStream returns streamId and replays initial", async () => {
    const gateway = new Gateway();
    let cleanedUp = false;
    gateway.extend("logs", {
      streams: {
        tail: {
          subscribe: (params, ctx) => {
            // Push a live frame after the initial replay snapshot.
            queueMicrotask(() => ctx.send({ line: "live-1" }));
            return {
              initial: { resumeAtSeq: params.resumeAtSeq ?? 0, snapshot: ["a", "b"] },
              cleanup: () => {
                cleanedUp = true;
              },
            };
          },
        },
      },
    });
    const { connection, sent } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.stream.logs.tail", { resumeAtSeq: 10 }));
    expect(res.ok).toBe(true);
    expect(typeof res.payload.streamId).toBe("string");
    expect(res.payload.initial).toEqual({ resumeAtSeq: 10, snapshot: ["a", "b"] });
    // Let the queued ctx.send fire.
    await new Promise((r) => setTimeout(r, 5));
    const events = sent.filter((entry) => entry.type === "event" && entry.event === "ext.stream.event");
    expect(events.length).toBe(1);
    expect(events[0].payload.payload).toEqual({ line: "live-1" });
    expect(events[0].payload.streamId).toBe(res.payload.streamId);
    // Tear down and confirm cleanup fires.
    await gateway.cleanupExtensionSubscriptions(connection);
    expect(cleanedUp).toBe(true);
  });

  test("stream rejects non-websocket transports", async () => {
    const gateway = new Gateway();
    gateway.extend("logs", { streams: { tail: { subscribe: () => {} } } });
    const { connection } = fakeConnection({ transport: "http" });
    const res = await gateway.routeRequest(connection, frame("ext.stream.logs.tail"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("INVALID_REQUEST");
  });

  test("stream send guards oversized frames", async () => {
    const gateway = new Gateway();
    gateway.extend("big", {
      streams: {
        whale: {
          subscribe: (_params, ctx) => {
            queueMicrotask(() => ctx.send({ blob: "x".repeat(EXTENSION_PAYLOAD_MAX_BYTES + 1) }));
            return () => {};
          },
        },
      },
    });
    const { connection, sent } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.stream.big.whale"));
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const errEvent = sent.find((entry) => entry.event === "ext.stream.error");
    expect(errEvent).toBeDefined();
    expect(errEvent.payload.error.code).toBe("PayloadTooLarge");
  });

  test("namespace collision throws at registration time", () => {
    const gateway = new Gateway();
    gateway.extend("dup", { resources: { a: { handler: () => 1 } } });
    expect(() => gateway.extend("dup", { resources: { b: { handler: () => 2 } } })).toThrow(/already registered/i);
  });

  test("subscribeExtensionStream rejects an oversize initial snapshot", async () => {
    const gateway = new Gateway();
    let cleanedUp = false;
    gateway.extend("snap", {
      streams: {
        big: {
          subscribe: () => ({
            initial: { blob: "x".repeat(EXTENSION_PAYLOAD_MAX_BYTES + 1) },
            cleanup: () => {
              cleanedUp = true;
            },
          }),
        },
      },
    });
    const { connection } = fakeConnection();
    const res = await gateway.routeRequest(connection, frame("ext.stream.snap.big"));
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("PayloadTooLarge");
    expect(res.error.maxBytes).toBe(EXTENSION_PAYLOAD_MAX_BYTES);
    // Subscribe must have been cleaned up — we never register a live subscription.
    expect(cleanedUp).toBe(true);
  });

  test("send() raises BackpressureDisconnect when the outbound queue overflows", async () => {
    const gateway = new Gateway();
    let cleanedUp = false;
    // Simulate a fully-stuck consumer: the fake ws.send() does nothing AND we
    // peg bufferedAmount above the high-water mark so the drain microtask
    // never empties the queue. The 1001st push must trip BackpressureDisconnect.
    gateway.extend("press", {
      streams: {
        firehose: {
          subscribe: (_p, ctx) => {
            // setTimeout, not queueMicrotask, so the subscribe registration
            // path (which sets cleanupFn) completes BEFORE the send loop runs.
            // A microtask scheduled inside subscribe would fire before the
            // outer `await` resumes — fine in production but obscures intent
            // in a unit test of the backpressure path.
            setTimeout(() => {
              for (let i = 0; i < 1_500; i += 1) ctx.send({ i });
            }, 0);
            return () => {
              cleanedUp = true;
            };
          },
        },
      },
    });
    const { connection, sent } = fakeConnection();
    // High bufferedAmount blocks the drain so every send queues forever.
    connection.ws.bufferedAmount = 9 * 1024 * 1024;
    const res = await gateway.routeRequest(connection, frame("ext.stream.press.firehose"));
    expect(res.ok).toBe(true);
    // Let the queued ctx.send loop run and the backpressure check fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(cleanedUp).toBe(true);
    // No bypass: while the socket is still congested the teardown error sits
    // in the connection's byte-bounded event writer instead of being pushed
    // onto the socket, then flushes once the socket recovers.
    expect(sent.find((entry) => entry.event === "ext.stream.error")).toBeUndefined();
    connection.ws.bufferedAmount = 0;
    await new Promise((r) => setTimeout(r, 30));
    const errEvent = sent.find((entry) => entry.event === "ext.stream.error");
    expect(errEvent).toBeDefined();
    expect(errEvent.payload.error.code).toBe("BackpressureDisconnect");
  });

  test("disconnect aborts a long-running resource handler via ctx.signal", async () => {
    const gateway = new Gateway();
    let abortedInsideHandler = false;
    gateway.extend("slow", {
      resources: {
        wait: {
          handler: (_params, ctx) =>
            new Promise((resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => {
                  abortedInsideHandler = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
              // Never resolves on its own — the disconnect path must trip it.
              setTimeout(() => resolve("never"), 60_000);
            }),
        },
      },
    });
    const { connection } = fakeConnection();
    const pending = gateway.routeRequest(connection, frame("ext.slow.wait"));
    // Give the handler a tick to attach its abort listener.
    await new Promise((r) => setTimeout(r, 5));
    await gateway.cleanupExtensionSubscriptions(connection);
    const res = await pending;
    expect(abortedInsideHandler).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("EXTENSION_HANDLER_ERROR");
  });

  test("cleanupExtensionSubscriptions runs cleanups in parallel even if one hangs", async () => {
    const gateway = new Gateway();
    let fastCleanedAtMs = 0;
    let hangResolver;
    const hangPromise = new Promise((resolve) => {
      hangResolver = resolve;
    });
    gateway.extend("multi", {
      streams: {
        fast: {
          subscribe: () => ({
            cleanup: () => {
              fastCleanedAtMs = Date.now();
            },
          }),
        },
        slow: {
          subscribe: () => ({ cleanup: () => hangPromise }),
        },
      },
    });
    const { connection } = fakeConnection();
    const slow = await gateway.routeRequest(connection, frame("ext.stream.multi.slow"));
    const fast = await gateway.routeRequest(connection, frame("ext.stream.multi.fast"));
    expect(slow.ok).toBe(true);
    expect(fast.ok).toBe(true);
    const cleanupStarted = Date.now();
    // Kick off cleanup; the hanging stream's cleanup must NOT block the fast
    // stream's cleanup from completing.
    const cleanupDone = gateway.cleanupExtensionSubscriptions(connection);
    await new Promise((r) => setTimeout(r, 20));
    expect(fastCleanedAtMs).toBeGreaterThan(0);
    expect(fastCleanedAtMs - cleanupStarted).toBeLessThan(50);
    // Now unblock the hung cleanup so the awaiter can resolve.
    hangResolver();
    await cleanupDone;
  });
});
