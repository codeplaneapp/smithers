// `close()` is the disposal surface owners need: before it existed, a client
// whose owner had moved on (a rotated token, an unmounted provider) kept its
// in-flight RPCs and its subscribed sockets running with nobody left to stop
// them. These cover the whole contract: abort what is in flight, hang up open
// sockets, refuse new work, and stay idempotent.
import { describe, expect, test } from "bun:test";
import { SmithersGatewayClient } from "../src/index.ts";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  static afterOpen: (() => void) | undefined;
  static onSend: (() => void) | undefined;
  closeCount = 0;
  sendCount = 0;

  constructor(_url: string | URL) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      FakeWebSocket.afterOpen?.();
    });
  }

  send(raw: string) {
    this.sendCount += 1;
    FakeWebSocket.onSend?.();
    const frame = JSON.parse(raw) as { id: string; method: string };
    // The handshake wants a protocol; a stream subscribe wants a streamId, or
    // the generator rejects the response and ends before close() can matter.
    const payload = frame.method === "connect" ? { protocol: 1 } : { streamId: "stream-1" };
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }),
        }),
      );
    });
  }

  close() {
    this.closeCount += 1;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

/** A fetch that never settles until its request signal aborts. */
function hangingFetch(seen: AbortSignal[]): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal) seen.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

function okFetch(): typeof fetch {
  return (async () => Response.json({ type: "res", id: "http", ok: true, payload: {} })) as unknown as typeof fetch;
}

describe("SmithersGatewayClient.close", () => {
  test("aborts an in-flight RPC the caller never aborted", async () => {
    const signals: AbortSignal[] = [];
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test", fetch: hangingFetch(signals) });

    const inflight = client.rpcRaw("listRuns", {});
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    client.close();
    expect(signals[0]!.aborted).toBe(true);
    await expect(inflight).rejects.toThrow();
  });

  test("leaves a caller's own signal usable and still aborts through it", async () => {
    const signals: AbortSignal[] = [];
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test", fetch: hangingFetch(signals) });
    const caller = new AbortController();

    const inflight = client.rpcRaw("listRuns", {}, { signal: caller.signal });
    await Promise.resolve();
    client.close();

    expect(signals[0]!.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    await expect(inflight).rejects.toThrow();
  });

  test("hangs up sockets it opened and refuses to open more", async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.afterOpen = undefined;
    FakeWebSocket.onSend = undefined;
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connection = await client.connect();
    expect(connection.closed).toBe(false);

    client.close();
    expect(connection.closed).toBe(true);
    expect(FakeWebSocket.instances[0]!.closeCount).toBeGreaterThan(0);

    await expect(client.connect()).rejects.toThrow("Gateway client is closed.");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("stops tracking a socket the caller closed itself", async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.afterOpen = undefined;
    FakeWebSocket.onSend = undefined;
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    const connection = await client.connect();
    connection.close();
    const closesBefore = FakeWebSocket.instances[0]!.closeCount;

    client.close();
    expect(FakeWebSocket.instances[0]!.closeCount).toBe(closesBefore);
  });

  test("ends a live run-event stream", async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.afterOpen = undefined;
    FakeWebSocket.onSend = undefined;
    const client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    let ended = false;
    const drained = (async () => {
      try {
        for await (const _frame of client.streamRunEvents({ runId: "run-1" })) {
          // The fake never pushes frames; the loop parks until close() ends it.
        }
      } catch {
        // A closed socket surfaces as a throw; either way the iterator is done.
      }
      ended = true;
    })();

    await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(ended).toBe(false);

    client.close();
    await drained;
    expect(ended).toBe(true);
  });

  test("does not send a handshake when close races the socket open event", async () => {
    FakeWebSocket.instances = [];
    let client!: SmithersGatewayClient;
    FakeWebSocket.afterOpen = () => {
      client.close();
    };
    client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    await expect(client.connect()).rejects.toThrow("Gateway WebSocket open aborted.");
    expect(FakeWebSocket.instances[0]!.sendCount).toBe(0);
    expect(FakeWebSocket.instances[0]!.closeCount).toBe(1);
    FakeWebSocket.afterOpen = undefined;
  });

  test("observes a handshake rejection when close re-enters from send", async () => {
    FakeWebSocket.instances = [];
    FakeWebSocket.afterOpen = undefined;
    let client!: SmithersGatewayClient;
    FakeWebSocket.onSend = () => {
      client.close();
    };
    client = new SmithersGatewayClient({
      baseUrl: "http://gateway.test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });

    await expect(client.connect()).rejects.toThrow("Gateway WebSocket open aborted.");
    expect(FakeWebSocket.instances[0]!.sendCount).toBe(1);
    await Promise.resolve();
    FakeWebSocket.onSend = undefined;
  });

  test("reports closed, rejects new RPCs, and is idempotent", async () => {
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test", fetch: okFetch() });
    expect(client.closed).toBe(false);
    await client.rpcRaw("listRuns", {});

    client.close();
    client.close();

    expect(client.closed).toBe(true);
    await expect(client.rpcRaw("listRuns", {})).rejects.toThrow("Gateway client is closed.");
  });

  test("rejects a new resilient stream instead of silently ending it", async () => {
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test" });
    client.close();

    const next = client.streamRunEventsResilient({ runId: "run-1" }).next();
    await expect(next).rejects.toThrow("Gateway client is closed.");
  });

  test("closing one client leaves an independently built one alone", async () => {
    const shared = { baseUrl: "http://gateway.test", fetch: okFetch() };
    const first = new SmithersGatewayClient(shared);
    const second = new SmithersGatewayClient(shared);

    first.close();

    expect(second.closed).toBe(false);
    await expect(second.rpcRaw("listRuns", {})).resolves.toBeDefined();
  });
});
