// The provider owns the client it builds from `options`, so its memo decides
// which configuration subsequent requests actually run with. Memoizing on
// `baseUrl`/`token` alone froze the other behavior-affecting options: rotating
// `headers`, `fetch`, `WebSocket`, or the client metadata kept serving the
// original client, so the new credentials/transports never reached the wire.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SmithersGatewayClient, type SmithersGatewayClientOptions } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider, useSmithersGateway } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const client = useSmithersGateway();
  return createElement("span", null, client.baseUrl);
}

type Capture = { url: string; headers: Headers };

function capturingFetch(calls: Capture[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({ type: "res", id: "http", ok: true, payload: { runs: [] } });
  }) as unknown as typeof fetch;
}

type SocketLog = { urls: string[]; frames: Array<{ method: string; params: unknown }> };

/**
 * A WebSocket stand-in that opens immediately and answers every request frame
 * with an ok response, so `connect()` completes and the `connect` params (which
 * carry the client metadata) are observable.
 */
function fakeWebSocket(log: SocketLog): typeof WebSocket {
  return class FakeWebSocket {
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
    constructor(url: string) {
      log.urls.push(url);
      queueMicrotask(() => {
        this.dispatch("open", { type: "open" });
      });
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      const bucket = this.listeners.get(type) ?? new Set();
      bucket.add(listener);
      this.listeners.set(type, bucket);
    }
    removeEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.get(type)?.delete(listener);
    }
    send(data: string) {
      const frame = JSON.parse(data) as { id: string; method: string; params: unknown };
      log.frames.push({ method: frame.method, params: frame.params });
      queueMicrotask(() => {
        this.dispatch("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }) });
      });
    }
    close() {
      this.dispatch("close", { type: "close" });
    }
    private dispatch(type: string, event: unknown) {
      // Snapshot: `connect()` unregisters its own listeners while handling them.
      for (const listener of new Set(this.listeners.get(type))) listener(event);
    }
  } as unknown as typeof WebSocket;
}

async function mountHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (element: ReactElement) => {
      await act(async () => {
        root.render(element);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Renders the provider with `options` and hands back the client it owns. */
async function optionsHarness() {
  const harness = await mountHarness();
  let client!: SmithersGatewayClient;
  function Capture() {
    client = useSmithersGateway();
    return null;
  }
  return {
    render: async (options: SmithersGatewayClientOptions) => {
      await harness.render(createElement(SmithersGatewayProvider, { options }, createElement(Capture)));
      return client;
    },
    unmount: harness.unmount,
  };
}

describe("SmithersGatewayProvider", () => {
  test("provides the configured Gateway client", () => {
    const client = new SmithersGatewayClient({ baseUrl: "http://gateway.test" });
    const html = renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));
    expect(html).toContain("http://gateway.test");
  });

  test("rotated headers authorize subsequent requests", async () => {
    const calls: Capture[] = [];
    const fetchImpl = capturingFetch(calls);
    const harness = await optionsHarness();

    const first = await harness.render({
      baseUrl: "http://gateway.test",
      headers: { "x-api-key": "key-1" },
      fetch: fetchImpl,
    });
    await first.rpcRaw("listRuns", {});
    expect(calls.at(-1)!.headers.get("x-api-key")).toBe("key-1");

    const second = await harness.render({
      baseUrl: "http://gateway.test",
      headers: { "x-api-key": "key-2" },
      fetch: fetchImpl,
    });
    expect(second).not.toBe(first);
    await second.rpcRaw("listRuns", {});
    expect(calls.at(-1)!.headers.get("x-api-key")).toBe("key-2");

    await harness.unmount();
  });

  test("a rotated fetch transport carries subsequent requests", async () => {
    const firstCalls: Capture[] = [];
    const secondCalls: Capture[] = [];
    const harness = await optionsHarness();

    const first = await harness.render({ baseUrl: "http://gateway.test", fetch: capturingFetch(firstCalls) });
    await first.rpcRaw("listRuns", {});
    expect(firstCalls).toHaveLength(1);

    const second = await harness.render({ baseUrl: "http://gateway.test", fetch: capturingFetch(secondCalls) });
    await second.rpcRaw("listRuns", {});
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls).toHaveLength(1);

    await harness.unmount();
  });

  test("a rotated WebSocket and client metadata reach the next connect", async () => {
    const firstLog: SocketLog = { urls: [], frames: [] };
    const secondLog: SocketLog = { urls: [], frames: [] };
    const harness = await optionsHarness();

    const first = await harness.render({
      baseUrl: "http://gateway.test",
      WebSocket: fakeWebSocket(firstLog),
      client: { id: "ui-1", version: "1.0.0", platform: "browser" },
    });
    (await first.connect()).close();
    expect(firstLog.urls).toHaveLength(1);
    expect(firstLog.frames[0]).toMatchObject({
      method: "connect",
      params: { client: { id: "ui-1", version: "1.0.0" } },
    });

    const second = await harness.render({
      baseUrl: "http://gateway.test",
      WebSocket: fakeWebSocket(secondLog),
      client: { id: "ui-2", version: "2.0.0", platform: "browser" },
    });
    (await second.connect()).close();
    expect(firstLog.urls).toHaveLength(1);
    expect(secondLog.frames[0]).toMatchObject({
      method: "connect",
      params: { client: { id: "ui-2", version: "2.0.0" } },
    });

    await harness.unmount();
  });

  test("keeps the client across renders when inline options are unchanged", async () => {
    const fetchImpl = capturingFetch([]);
    const WebSocketImpl = fakeWebSocket({ urls: [], frames: [] });
    const harness = await optionsHarness();

    const first = await harness.render({
      baseUrl: "http://gateway.test",
      token: "tok",
      headers: { "x-api-key": "key-1", "x-tenant": "acme" },
      fetch: fetchImpl,
      WebSocket: WebSocketImpl,
      client: { id: "ui-1" },
    });
    // A fresh literal with the same content — including headers in a different
    // key order — must not rotate the client or its live connections.
    const second = await harness.render({
      baseUrl: "http://gateway.test",
      token: "tok",
      headers: { "x-tenant": "acme", "x-api-key": "key-1" },
      fetch: fetchImpl,
      WebSocket: WebSocketImpl,
      client: { id: "ui-1" },
    });
    expect(second).toBe(first);

    await harness.unmount();
  });
});
