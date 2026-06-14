// Drives the real gateway-react hooks through React's real reconciler under a
// real DOM (happy-dom) so that useEffect actually runs and state updates flush.
// No hook logic is faked: the test client implements the genuine async-generator
// / rpc contracts and we observe the hooks' real reactions to real inputs.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Other test files in this package also call register(); the second call
// throws "already registered". Idempotent guard keeps test order independent.
try { GlobalRegistrator.register(); } catch { /* already registered */ }

import { describe, expect, test } from "bun:test";
import { act, createElement, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayClient as RealSmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import {
  SmithersGatewayContext,
  SmithersGatewayProvider,
  useGatewayRpc,
} from "../src/index.ts";

// React's act() requires this flag so updates are flushed synchronously and
// warnings are suppressed in the bun + happy-dom test environment.
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

// `useGatewayRunEvents` is now backed by the `SyncProvider` registry's
// `runEvents` collection; its heartbeat-filtering + ring-cap behavior is covered
// in `tests/sync/sync.test.ts`.

describe("SmithersGatewayProvider", () => {
  test("an inline options literal does not recreate the client across renders (memoized on baseUrl/token)", async () => {
    const observed: SmithersGatewayClient[] = [];
    function Capture() {
      return createElement(SmithersGatewayContext.Consumer, {
        children: (value: SmithersGatewayClient | null) => {
          if (value) observed.push(value);
          return null;
        },
      });
    }

    // Each render passes a brand-new options object literal with identical
    // baseUrl/token. The provider must memoize on those primitives and keep the
    // same client identity rather than reconnecting every render.
    const tree = () =>
      createElement(
        SmithersGatewayProvider,
        { options: { baseUrl: "http://gateway.test", token: "tok-1" } },
        createElement(Capture),
      );

    const harness = await mountHarness();
    await harness.render(tree());
    await harness.render(tree());
    await harness.render(tree());

    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed[0]).toBeInstanceOf(RealSmithersGatewayClient);
    const first = observed[0];
    for (const client of observed) {
      expect(client).toBe(first);
    }

    await harness.unmount();
  });

  test("a changed baseUrl does recreate the client", async () => {
    const observed: SmithersGatewayClient[] = [];
    function Capture() {
      return createElement(SmithersGatewayContext.Consumer, {
        children: (value: SmithersGatewayClient | null) => {
          if (value) observed.push(value);
          return null;
        },
      });
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersGatewayProvider,
        { options: { baseUrl: "http://a.test" } },
        createElement(Capture),
      ),
    );
    const firstClient = observed[observed.length - 1];
    await harness.render(
      createElement(
        SmithersGatewayProvider,
        { options: { baseUrl: "http://b.test" } },
        createElement(Capture),
      ),
    );
    const secondClient = observed[observed.length - 1];

    expect(firstClient).toBeInstanceOf(RealSmithersGatewayClient);
    expect(secondClient).toBeInstanceOf(RealSmithersGatewayClient);
    expect(secondClient).not.toBe(firstClient);

    await harness.unmount();
  });
});

describe("useGatewayRpc", () => {
  test("the fetch effect re-runs only when its real deps change, not on every render", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve({ ok: true });
      },
    } as unknown as SmithersGatewayClient;

    // An unrelated state value changes every render via an effect, forcing
    // multiple commits. The rpc params are structurally identical each render,
    // so useGatewayRpc must NOT re-issue the request on those churn renders.
    let renderCount = 0;
    function Probe(props: { onMount: () => void }) {
      renderCount += 1;
      useGatewayRpc("listRuns", { limit: 5 });
      // Force a second render right after mount to simulate unrelated parent
      // churn — the rpc deps are unchanged, so no second rpc call should fire.
      useEffect(() => {
        if (renderCount === 1) {
          props.onMount();
        }
      });
      return null;
    }

    function Wrapper() {
      const [, setTick] = useState(0);
      const onMount = () => setTick((n) => n + 1);
      return createElement(
        SmithersGatewayProvider,
        { client },
        createElement(Probe, { onMount }),
      );
    }

    const harness = await mountHarness();
    await harness.render(createElement(Wrapper));

    // Despite multiple renders, only one rpc call should have been issued
    // because the serialized params (the real dep) never changed.
    expect(renderCount).toBeGreaterThan(1);
    expect(calls).toEqual([{ method: "listRuns", params: { limit: 5 } }]);

    await harness.unmount();
  });

  test("disabling the query clears prior data so stale results are not surfaced", async () => {
    // Mirrors useGatewayRun(undefined): when a query becomes disabled (e.g. the
    // runId is cleared) the hook must drop the previous payload instead of
    // continuing to surface it. A late-resolving in-flight request must also not
    // repopulate the cleared state.
    let resolveRpc: ((value: unknown) => void) | undefined;
    const client = {
      rpc: (_method: string, _params: unknown) =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayRpc> | undefined;
    function Probe(props: { enabled: boolean }) {
      snapshot = useGatewayRpc("getRun", { runId: "run-1" }, { enabled: props.enabled, deps: ["run-1"] });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { enabled: true })),
    );
    // Resolve the first request so the hook holds real data.
    await act(async () => {
      resolveRpc?.({ run: { id: "run-1" } });
    });
    expect(snapshot?.data).toEqual({ run: { id: "run-1" } });
    expect(snapshot?.loading).toBe(false);

    // Disable the query: data and error must clear and loading must be false.
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { enabled: false })),
    );
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.loading).toBe(false);

    await harness.unmount();
  });

  test("changing the key clears prior data so the old key's result is not shown during refetch", async () => {
    // When the param key changes (e.g. runId switches), the hook must not keep
    // surfacing the previous key's payload while the new request is in flight.
    const resolvers = new Map<string, (value: unknown) => void>();
    const client = {
      rpc: (_method: string, params: { runId: string }) =>
        new Promise((resolve) => {
          resolvers.set(params.runId, resolve);
        }),
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayRpc> | undefined;
    function Probe(props: { runId: string }) {
      snapshot = useGatewayRpc("getRun", { runId: props.runId }, { deps: [props.runId] });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: "run-1" })),
    );
    await act(async () => {
      resolvers.get("run-1")?.({ run: { id: "run-1" } });
    });
    expect(snapshot?.data).toEqual({ run: { id: "run-1" } });

    // Switch the key: the prior payload must be dropped immediately and the hook
    // re-enters loading until the new request resolves.
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: "run-2" })),
    );
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.loading).toBe(true);

    await act(async () => {
      resolvers.get("run-2")?.({ run: { id: "run-2" } });
    });
    expect(snapshot?.data).toEqual({ run: { id: "run-2" } });

    await harness.unmount();
  });

  test("a late response from the previous key never repopulates cleared state", async () => {
    // The stale-data-free model documented in /guides/custom-workflow-ui leans
    // on a generation-tagged drop: when inputs change, the hook clears data and
    // bumps a generation counter, so a still-in-flight response for the prior
    // inputs is dropped on arrival rather than overwriting the new state. This
    // is the exact failure mode an iframe-embedded custom UI would otherwise
    // hit when the host swaps `runId` while the previous run's RPC is mid-air.
    const resolvers = new Map<string, (value: unknown) => void>();
    const client = {
      rpc: (_method: string, params: { runId: string }) =>
        new Promise((resolve) => {
          resolvers.set(params.runId, resolve);
        }),
    } as unknown as SmithersGatewayClient;

    let snapshot: ReturnType<typeof useGatewayRpc> | undefined;
    function Probe(props: { runId: string }) {
      snapshot = useGatewayRpc("getRun", { runId: props.runId }, { deps: [props.runId] });
      return null;
    }

    const harness = await mountHarness();
    // Mount with run-1; do NOT resolve its request — it stays in flight.
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: "run-1" })),
    );
    expect(snapshot?.loading).toBe(true);

    // Switch to run-2 BEFORE run-1 resolves. The hook must clear data and
    // remain in loading; the run-1 promise is now "stale".
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: "run-2" })),
    );
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.loading).toBe(true);

    // Now resolve the STALE run-1 request. It must not repopulate the
    // cleared state — the run-2 hook generation has moved past it.
    await act(async () => {
      resolvers.get("run-1")?.({ run: { id: "run-1" } });
    });
    expect(snapshot?.data).toBeUndefined();
    expect(snapshot?.loading).toBe(true);

    // The new request resolves last and is the one that wins.
    await act(async () => {
      resolvers.get("run-2")?.({ run: { id: "run-2" } });
    });
    expect(snapshot?.data).toEqual({ run: { id: "run-2" } });
    expect(snapshot?.loading).toBe(false);

    await harness.unmount();
  });

  test("changing params re-issues exactly one additional rpc call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      rpc: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve({ ok: true });
      },
    } as unknown as SmithersGatewayClient;

    function Probe(props: { limit: number }) {
      useGatewayRpc("listRuns", { limit: props.limit });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { limit: 5 })),
    );
    // Re-render with identical params: no new call.
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { limit: 5 })),
    );
    expect(calls.length).toBe(1);

    // Re-render with changed params: exactly one new call.
    await harness.render(
      createElement(SmithersGatewayProvider, { client }, createElement(Probe, { limit: 9 })),
    );
    expect(calls).toEqual([
      { method: "listRuns", params: { limit: 5 } },
      { method: "listRuns", params: { limit: 9 } },
    ]);

    await harness.unmount();
  });
});
