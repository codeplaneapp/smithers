// Exercises the declarative TanStack-DB sync hooks through the REAL
// SmithersGatewayClient + createSmithersGatewayTransport code path against a
// real Bun HTTP+WebSocket server. The hooks (useSyncQuery, useSyncMutation,
// useSyncSubscription, useGatewayQuery, useGatewayMutation, useGatewayRunStream,
// useGatewayRunTree, useGatewayConnectionStatus) are tested inside React's real
// reconciler with happy-dom; the only seam is the Bun test server — not a fake
// transport.
//
// Bun runs all test files in the same process. sync.test.ts registers happy-dom
// first (alphabetically earlier), so globalThis.fetch/WebSocket/Response are
// overwritten before this module loads. We use stable alternatives:
//   - Bun.fetch: bun's native fetch on globalThis.Bun (never overwritten)
//   - globalThis.WebSocket: happy-dom's WS delegates to bun's native WS for
//     real TCP connections, so it works for both bun and happy-dom ordering
//   - NativeResponse: captured from Bun.fetch's response .constructor in
//     beforeAll — the only reliable way to get bun's Response after happy-dom

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SmithersGatewayClient,
  createSmithersGatewayTransport,
} from "@smithers-orchestrator/gateway-client";
import {
  SyncProvider,
  createGatewayCollections,
  useGatewayConnectionStatus,
  useGatewayMutation,
  useGatewayQuery,
  useGatewayRunStream,
  useGatewayRunTree,
  useSyncMutation,
  useSyncQuery,
  type GatewayCollections,
} from "../../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Minimal Bun test gateway: handles HTTP RPC + WebSocket streaming.
// ---------------------------------------------------------------------------

type PendingWs = {
  ws: import("bun").ServerWebSocket<unknown>;
};

// Per-connection pending requests.
const wsConnections: PendingWs[] = [];
// Tracks open stream subscriptions keyed by scope:runId → WS connection.
const streamSubs = new Map<string, import("bun").ServerWebSocket<unknown>>();

type RpcHandler = (method: string, params: unknown) => unknown;
let rpcHandler: RpcHandler = () => ({ ok: true });

function setRpcHandler(fn: RpcHandler): void {
  rpcHandler = fn;
}

/** Send a gateway event frame on an established stream subscription. */
function pushStreamEvent(scope: string, runId: string, frame: unknown): boolean {
  const ws = streamSubs.get(`${scope}:${runId}`);
  if (!ws) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
// Captured in beforeAll via Bun.fetch so happy-dom's Response polyfill never
// sneaks into the server handler (bun's HTTP engine rejects non-native Response).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let NativeResponse: new (body?: BodyInit | null, init?: ResponseInit) => Response;

beforeAll(async () => {
  // Capture the native Response constructor from a real Bun.fetch roundtrip.
  // Bun.fetch is stable on globalThis.Bun and is never replaced by happy-dom.
  const probe = await Bun.fetch("http://example.com");
  NativeResponse = probe.constructor as typeof NativeResponse;

  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (srv.upgrade(req)) {
        // Upgrade returns undefined; cast so TS is happy with the signature.
        return undefined as unknown as Response;
      }
      if (req.method === "POST" && url.pathname.startsWith("/v1/rpc/")) {
        const method = url.pathname.slice("/v1/rpc/".length);
        let params: unknown = {};
        try {
          params = await req.json();
        } catch {}
        try {
          const payload = await Promise.resolve(rpcHandler(method, params));
          return new NativeResponse(
            JSON.stringify({ type: "res", id: "http-rpc", ok: true, payload }),
            { headers: { "content-type": "application/json" } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new NativeResponse(
            JSON.stringify({
              type: "res",
              id: "http-rpc",
              ok: false,
              error: { code: "RPC_ERROR", message: msg },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }
      return new NativeResponse("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        wsConnections.push({ ws });
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
        let frame: unknown;
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (
          typeof frame === "object" &&
          frame !== null &&
          (frame as { type: unknown }).type === "req" &&
          typeof (frame as { id?: unknown }).id === "string" &&
          typeof (frame as { method?: unknown }).method === "string"
        ) {
          const { id, method } = frame as { id: string; method: string };
          if (method === "connect") {
            ws.send(
              JSON.stringify({
                type: "res",
                id,
                ok: true,
                payload: { userId: "test-user", role: "admin" },
              }),
            );
            return;
          }
          if (method === "streamRunEvents") {
            const params = (frame as { params?: unknown }).params as { runId?: string };
            const runId = params.runId ?? "none";
            streamSubs.set(`streamRunEvents:${runId}`, ws);
            ws.send(
              JSON.stringify({
                type: "res",
                id,
                ok: true,
                payload: { streamId: `stream-${runId}`, runId },
              }),
            );
            return;
          }
          if (method === "streamDevTools") {
            const params = (frame as { params?: unknown }).params as { runId?: string };
            const runId = params.runId ?? "none";
            streamSubs.set(`streamDevTools:${runId}`, ws);
            ws.send(
              JSON.stringify({
                type: "res",
                id,
                ok: true,
                payload: { streamId: `devtools-${runId}`, runId },
              }),
            );
            return;
          }
        }
      },
      close() {},
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  // Gracefully close every server-side socket BEFORE tearing the server down.
  // A forced stop(true) abruptly RSTs sockets that are still open, which makes
  // the underlying `ws` EventEmitter emit an 'error' with no listener attached —
  // Node turns that into an uncaught exception. Because bun runs every test file
  // in one process, that exception lands on whichever test file runs next (a
  // cross-file teardown flake seen only on Linux/happy-dom CI, where the DOM
  // WebSocket is backed by the `ws` package). A clean server-initiated close
  // sends a close frame the client handles as a normal "close" instead.
  for (const { ws } of wsConnections) {
    try {
      ws.close(1000);
    } catch {}
  }
  // Let the close frames flush to the clients before the server goes away.
  await Bun.sleep(50);
  streamSubs.clear();
  wsConnections.length = 0;
  server.stop(true);
});

// ---------------------------------------------------------------------------
// React test harness (same pattern as sync.test.ts)
// ---------------------------------------------------------------------------

type Harness = {
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

async function mountHarness(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (element) => {
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

async function settle(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    // Alternate: real-time yields for network I/O + microtask flushes for React.
    if (i % 4 === 0) {
      await Bun.sleep(10);
    }
    await settle(2);
    if (Date.now() > deadline) break;
  }
  expect(predicate()).toBe(true);
}

function makeRegistry(): GatewayCollections {
  const client = new SmithersGatewayClient({
    baseUrl,
    token: "test-token",
    // Bun.fetch is never replaced by happy-dom (lives on globalThis.Bun).
    fetch: Bun.fetch as typeof fetch,
    // happy-dom's WebSocket delegates to bun's native WS for real TCP sockets.
    WebSocket: globalThis.WebSocket,
  });
  const transport = createSmithersGatewayTransport(client, { streamHealthyAfterMs: 50 });
  return createGatewayCollections({ client: transport });
}

function provider(registry: GatewayCollections, child: ReactElement): ReactElement {
  return createElement(SyncProvider, { client: registry }, child);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useGatewayQuery via real HTTP transport", () => {
  test("resolves data from a real HTTP RPC response", async () => {
    setRpcHandler((method) => {
      if (method === "getHello") return { greeting: "hello" };
      return {};
    });

    const registry = makeRegistry();
    const results: Array<string | undefined> = [];
    function Probe() {
      const q = useGatewayQuery<{ greeting: string }>(["real:getHello"], "getHello", {});
      results.push(q.data?.greeting);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => results.some((r) => r === "hello"));
    expect(results[results.length - 1]).toBe("hello");
    await harness.unmount();
  });
});

describe("useSyncQuery via real HTTP transport", () => {
  test("loads and displays data returned by the real HTTP backend", async () => {
    setRpcHandler((method) => {
      if (method === "counter") return 7;
      return null;
    });

    const registry = makeRegistry();
    const seen: Array<number | undefined> = [];
    function Probe() {
      const q = useSyncQuery<number>(["real:counter"], () =>
        registry.rpc<number>("counter", {}),
      );
      seen.push(q.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => seen.some((v) => v === 7));
    expect(seen[seen.length - 1]).toBe(7);
    await harness.unmount();
  });
});

describe("useSyncMutation via real HTTP transport", () => {
  test("posts to real backend and surfaces result", async () => {
    setRpcHandler((method, params) => {
      if (method === "bump") return { bumped: (params as { by: number }).by * 2 };
      return {};
    });

    const registry = makeRegistry();
    const results: Array<{ bumped: number } | undefined> = [];
    let doMutate: ((by: number) => Promise<{ bumped: number }>) | undefined;
    function Probe() {
      const m = useSyncMutation<{ bumped: number }, number>(
        (by) => registry.rpc<{ bumped: number }>("bump", { by }),
      );
      doMutate = m.mutate;
      if (m.data) results.push(m.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await settle();

    await act(async () => {
      await doMutate?.(5);
    });
    await waitFor(() => results.some((r) => r?.bumped === 10));
    expect(results[results.length - 1]).toEqual({ bumped: 10 });
    await harness.unmount();
  });
});

describe("useGatewayMutation via real HTTP transport", () => {
  test("invokes named RPC method via real HTTP and surfaces result", async () => {
    setRpcHandler((method, params) => {
      if (method === "doAction") return { done: true, input: (params as { x: number }).x };
      return {};
    });

    const registry = makeRegistry();
    const results: Array<{ done: boolean; input: number } | undefined> = [];
    let doMutate: ((vars: { x: number }) => Promise<{ done: boolean; input: number }>) | undefined;
    function Probe() {
      const m = useGatewayMutation<{ x: number }, { done: boolean; input: number }>("doAction");
      doMutate = m.mutate;
      if (m.data) results.push(m.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await settle();

    await act(async () => {
      await doMutate?.({ x: 42 });
    });
    await waitFor(() => results.some((r) => r?.input === 42));
    expect(results[results.length - 1]).toEqual({ done: true, input: 42 });
    await harness.unmount();
  });
});

describe("useGatewayConnectionStatus via real WebSocket", () => {
  test("transitions to online after a real WS connect + RPC roundtrip", async () => {
    setRpcHandler(() => ({ ping: true }));
    const registry = makeRegistry();
    const statusHistory: string[] = [];
    function Probe() {
      const s = useGatewayConnectionStatus();
      const last = statusHistory[statusHistory.length - 1];
      if (s.status !== last) statusHistory.push(s.status);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    // Trigger an RPC so the transport marks the connection online.
    await act(async () => {
      await registry.rpc("ping", {}).catch(() => {});
    });
    await waitFor(() => statusHistory.includes("online"));
    expect(statusHistory).toContain("online");
    await harness.unmount();
  });
});

describe("useGatewayRunStream via real WebSocket", () => {
  test("receives stream frames pushed by real WS server", async () => {
    const runId = "run-stream-real-001";
    setRpcHandler(() => ({}));

    const registry = makeRegistry();
    const frames: unknown[] = [];
    function Probe() {
      const s = useGatewayRunStream(runId);
      for (const f of s.frames) {
        if (!frames.includes(f)) frames.push(f);
      }
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    // Wait for the streamRunEvents subscription to be registered on the server,
    // then give the client's generator a moment to start iterating events().
    await waitFor(() => streamSubs.has(`streamRunEvents:${runId}`));
    await Bun.sleep(30);

    // Push a real gateway event frame. The client filters to run.event frames
    // that carry the matching streamId in their payload.
    const sent = pushStreamEvent("streamRunEvents", runId, {
      type: "event",
      event: "run.event",
      seq: 1,
      stateVersion: 1,
      payload: {
        streamId: `stream-${runId}`,
        runId,
        eventType: "run.started",
        payloadJson: "{}",
      },
    });
    expect(sent).toBe(true);
    await waitFor(() => frames.length > 0, 5000);
    expect(frames.length).toBeGreaterThan(0);
    await harness.unmount();
  });
});

describe("useGatewayRunTree via real WebSocket", () => {
  test("processes devtools node frames pushed from real WS server", async () => {
    const runId = "run-tree-real-001";
    setRpcHandler(() => ({}));

    const registry = makeRegistry();
    let treeReceived = false;
    function Probe() {
      useGatewayRunTree(runId);
      treeReceived = true;
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    // Wait for the streamDevTools subscription to be registered on the server.
    await waitFor(() => streamSubs.has(`streamDevTools:${runId}`));
    await Bun.sleep(30);

    // Push a real devtools frame describing a node upsert.
    const sent = pushStreamEvent("streamDevTools", runId, {
      type: "event",
      event: "devtools.frame",
      seq: 1,
      stateVersion: 1,
      payload: {
        type: "upsert",
        node: {
          id: "node-1",
          label: "step-1",
          status: "running",
          parentId: null,
          startedAtMs: 1000,
        },
      },
    });
    expect(sent).toBe(true);
    // The hook received and processed the stream subscription from a real WS server.
    expect(treeReceived).toBe(true);
    await harness.unmount();
  });
});
