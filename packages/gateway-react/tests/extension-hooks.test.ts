// Drives the extension hooks through React's real reconciler under happy-dom.
// We provide a hand-rolled client that satisfies the SmithersGatewayClient
// surface we exercise (extensionRpc, streamExtension) so the hooks see the
// real shape they ship for production use.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Other tests in this package also register happy-dom into the same bun
// process. The second register() throws — guard so test order doesn't matter.
try { GlobalRegistrator.register(); } catch { /* already registered */ }

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import {
  SmithersGatewayProvider,
  useGatewayExtensionAction,
  useGatewayExtensionResource,
  useGatewayExtensionStream,
} from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("useGatewayExtensionResource", () => {
  test("fetches via extensionRpc and surfaces data", async () => {
    const calls: Array<{ namespace: string; key: string; params: unknown }> = [];
    const client = {
      extensionRpc: async (namespace: string, key: string, params: unknown) => {
        calls.push({ namespace, key, params });
        return { id: (params as { id: string }).id, status: "open" };
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionResource> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionResource("github", "issue", { id: "42" });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    // useEffect flushes within act; wait a microtask for the rpc promise to land.
    await act(async () => { await Promise.resolve(); });

    expect(calls).toEqual([{ namespace: "github", key: "issue", params: { id: "42" } }]);
    expect(snapshot?.data).toEqual({ id: "42", status: "open" });
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.loading).toBe(false);
    await harness.unmount();
  });

  test("stale resolves do not overwrite fresh data (generation guard)", async () => {
    // The first call resolves SLOWLY; the second call resolves quickly. The hook
    // must only render the latest result, not the slow earlier one.
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstPromise = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
    let callCount = 0;
    const client = {
      extensionRpc: async (_namespace: string, _key: string, params: unknown) => {
        callCount += 1;
        if (callCount === 1) {
          return firstPromise as unknown as Promise<{ tag: string }>;
        }
        return { tag: (params as { tag: string }).tag };
      },
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionResource> | undefined;
    let setParams: ((p: { tag: string }) => void) | undefined;
    function Probe() {
      // Use a setState-driven param swap to force a re-render with new deps.
      const [params, setP] = (require("react") as typeof import("react")).useState({ tag: "first" });
      setParams = setP;
      snapshot = useGatewayExtensionResource("ns", "key", params);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    await act(async () => {
      setParams?.({ tag: "second" });
    });
    // Let the SECOND rpc resolve (it's already resolved by virtue of being synchronous).
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(snapshot?.data).toEqual({ tag: "second" });

    // Now resolve the FIRST (stale) call. It must not overwrite the fresh data.
    await act(async () => {
      resolveFirst?.({ tag: "stale" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(snapshot?.data).toEqual({ tag: "second" });
    await harness.unmount();
  });
});

describe("useGatewayExtensionAction", () => {
  test("call() invokes extensionRpc with passed params and surfaces data", async () => {
    const calls: Array<{ namespace: string; key: string; params: unknown }> = [];
    const client = {
      extensionRpc: async (namespace: string, key: string, params: unknown) => {
        calls.push({ namespace, key, params });
        return { ok: true };
      },
    } as unknown as SmithersGatewayClient;

    let hook: ReturnType<typeof useGatewayExtensionAction> | undefined;
    function Probe() {
      hook = useGatewayExtensionAction("ops", "restart");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    await act(async () => {
      await hook?.call({ service: "api" });
    });
    expect(calls).toEqual([{ namespace: "ops", key: "restart", params: { service: "api" } }]);
    expect(hook?.data).toEqual({ ok: true });
    expect(hook?.error).toBeUndefined();
    expect(hook?.pending).toBe(false);
    await harness.unmount();
  });
});

describe("useGatewayExtensionStream", () => {
  test("does not report streaming before the subscription effect starts", async () => {
    const streamingSnapshots: boolean[] = [];
    const client = {
      streamExtension: async function* () {
        await new Promise(() => {});
      },
    } as unknown as SmithersGatewayClient;

    function Probe() {
      const snapshot = useGatewayExtensionStream("logs", "tail");
      streamingSnapshots.push(snapshot.streaming);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );

    expect(streamingSnapshots[0]).toBe(false);
    await harness.unmount();
  });

  test("re-renders with a fresh backoff literal do NOT re-subscribe", async () => {
    // The hook used to depend on `options.backoff` as an unstable object
    // reference, so every parent re-render would tear down + resubscribe.
    // Now backoff is hashed into a string key — a fresh-but-equal literal
    // must keep the same subscription.
    let subscribeCount = 0;
    async function* yieldFrames() {
      subscribeCount += 1;
      yield { tick: subscribeCount };
      // Stay alive — block on a pending promise so the iterator does not end.
      await new Promise(() => {});
    }
    const client = {
      streamExtension: () => yieldFrames(),
    } as unknown as SmithersGatewayClient;

    let setReRenderToken: ((value: number) => void) | undefined;
    function Probe() {
      const [token, setToken] = (require("react") as typeof import("react")).useState(0);
      setReRenderToken = setToken;
      // Fresh object literal each render — used to bust the deps array.
      useGatewayExtensionStream("logs", "tail", {}, { backoff: { baseMs: 100, maxMs: 1000 } });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    await act(async () => { await Promise.resolve(); });
    const subscribesBeforeRerender = subscribeCount;
    await act(async () => { setReRenderToken?.(1); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { setReRenderToken?.(2); });
    await act(async () => { await Promise.resolve(); });
    expect(subscribeCount).toBe(subscribesBeforeRerender);
    await harness.unmount();
  });

  test("ring buffer caps the frames array even with a chatty extension", async () => {
    const total = 60;
    const maxFrames = 10;
    async function* yieldFrames() {
      for (let i = 1; i <= total; i += 1) yield { line: i };
    }
    const client = {
      streamExtension: () => yieldFrames(),
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionStream> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionStream<{ line: number }>("logs", "tail", {}, { maxFrames });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );
    await act(async () => { await Promise.resolve(); });

    expect(snapshot?.frames.length).toBe(maxFrames);
    expect(snapshot?.frames.map((f) => f.line)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    expect(snapshot?.latest).toEqual({ line: 60 });
    await harness.unmount();
  });

  test("surfaces a stream error, reconnects, and keeps subsequent frames", async () => {
    const calls: Array<{ namespace: string; key: string; params: unknown }> = [];
    const firstError = new Error("socket dropped");
    async function* failingThenLive(namespace: string, key: string, params: unknown) {
      calls.push({ namespace, key, params });
      if (calls.length === 1) {
        yield { seq: 1 };
        throw firstError;
      }
      yield { seq: 2 };
      await new Promise(() => {});
    }
    const client = {
      streamExtension: failingThenLive,
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayExtensionStream<{ seq: number }>> | undefined;
    function Probe() {
      snapshot = useGatewayExtensionStream<{ seq: number }>(
        "logs",
        "tail",
        { runId: "run-1" },
        { backoff: { baseMs: 0, maxMs: 0, jitter: 0 } },
      );
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe)),
    );

    for (let i = 0; i < 10 && calls.length < 2; i += 1) {
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(calls).toEqual([
      { namespace: "logs", key: "tail", params: { runId: "run-1" } },
      { namespace: "logs", key: "tail", params: { runId: "run-1" } },
    ]);
    expect(snapshot?.error).toBe(firstError);
    expect(snapshot?.streaming).toBe(true);
    expect(snapshot?.frames).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(snapshot?.latest).toEqual({ seq: 2 });

    await harness.unmount();
  });
});
