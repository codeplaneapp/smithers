// Drives the real sync hooks through React's real reconciler under a real DOM
// (happy-dom) so TanStack DB's `useLiveQuery` actually subscribes and
// re-renders. The collections, registry, and reconcile logic are the real ones;
// the only seam is a fake `SyncTransport` whose rpc/stream handlers return real
// promises and real async iterables (no hook logic is faked).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// happy-dom errors if registered twice across test files in the same bun run.
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

import { describe, expect, test } from "bun:test";
import { act, createElement, useContext, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  gatewayKeys,
  type SyncStreamFrame,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import {
  SyncContext,
  SyncProvider,
  createGatewayCollections,
  useSyncClient,
  useGatewayApprovals,
  useGatewayCrons,
  useGatewayMemoryFacts,
  useGatewayPrompts,
  useGatewayScores,
  useGatewayTickets,
  useGatewayConnectionStatus,
  useGatewayMutation,
  useGatewayQuery,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunStream,
  useGatewayRunTree,
  useGatewayRuns,
  useGatewayWorkflows,
  useSyncMutation,
  useSyncQuery,
  useSyncSubscription,
  type GatewayCollections,
  type UseSyncSubscriptionResult,
} from "../../src/index.ts";

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

async function settle(times = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await settle(2);
  }
  expect(predicate()).toBe(true);
}

/** A controllable fake transport: rpc dispatch + per-(scope,runId) stream channels. */
function makeTransport(rpc: SyncTransport["rpc"]) {
  type Channel = { queue: SyncStreamFrame[]; waiters: Array<() => void>; ended: boolean; error?: Error };
  const channels = new Map<string, Channel>();
  const opens: Array<{ scope: string; params: unknown; afterSeq?: number; signal?: AbortSignal }> = [];
  const channel = (key: string): Channel => {
    let chan = channels.get(key);
    if (!chan) {
      chan = { queue: [], waiters: [], ended: false };
      channels.set(key, chan);
    }
    return chan;
  };
  const runIdOf = (params: unknown): string =>
    params && typeof params === "object" ? String((params as { runId?: unknown }).runId ?? "") : "";

  const transport: SyncTransport = {
    rpc,
    stream(scope, params, options) {
      const key = `${scope}:${runIdOf(params)}`;
      opens.push({ scope, params, afterSeq: options.afterSeq, signal: options.signal });
      const chan = channel(key);
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (options.signal?.aborted) return;
            const frame = chan.queue.shift();
            if (frame) {
              yield frame;
              continue;
            }
            if (chan.ended) return;
            if (chan.error) throw chan.error;
            await new Promise<void>((resolve) => {
              chan.waiters.push(resolve);
              options.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        },
      };
    },
  };

  return {
    transport,
    opens,
    push(scope: string, runId: string | undefined, frame: SyncStreamFrame) {
      const chan = channel(`${scope}:${runId ?? ""}`);
      chan.queue.push(frame);
      for (const waiter of chan.waiters.splice(0)) waiter();
    },
    fail(scope: string, runId: string | undefined, error: Error) {
      const chan = channel(`${scope}:${runId ?? ""}`);
      chan.error = error;
      for (const waiter of chan.waiters.splice(0)) waiter();
    },
  };
}

function provider(registry: GatewayCollections, child: ReactElement): ReactElement {
  return createElement(SyncProvider, { client: registry }, child);
}

describe("useSyncQuery over the registry", () => {
  test("re-renders from loading to success when the fetcher resolves", async () => {
    let resolveFetch: (v: number) => void = () => {};
    const registry = createGatewayCollections({
      client: makeTransport(() => new Promise<number>((resolve) => (resolveFetch = resolve))).transport,
    });

    const seen: Array<{ status: string; data: number | undefined }> = [];
    function Probe() {
      const q = useSyncQuery<number>(["counter"], () => registry.rpc<number>("get", {}));
      seen.push({ status: q.status, data: q.data });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await settle();
    expect(seen[seen.length - 1]).toEqual({ status: "loading", data: undefined });

    await act(async () => {
      resolveFetch(42);
    });
    await settle();
    expect(seen[seen.length - 1]).toEqual({ status: "success", data: 42 });

    await harness.unmount();
  });

  test("refetch re-runs the fetcher and re-renders with the fresh value", async () => {
    let count = 0;
    const registry = createGatewayCollections({ client: makeTransport(() => Promise.resolve(++count)).transport });

    let lastRefetch: (() => Promise<unknown>) | undefined;
    const renders: number[] = [];
    function Probe() {
      const q = useSyncQuery<number>(["counter"], () => registry.rpc<number>("get", {}));
      lastRefetch = q.refetch;
      if (typeof q.data === "number") renders.push(q.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => renders[renders.length - 1] === 1);

    await act(async () => {
      await lastRefetch?.();
    });
    await waitFor(() => renders[renders.length - 1] === 2);

    await harness.unmount();
  });

  test("setQueryData (optimistic push) re-renders subscribers", async () => {
    const registry = createGatewayCollections({ client: makeTransport(() => Promise.resolve(1)).transport });

    const observed: number[] = [];
    function Probe() {
      const q = useSyncQuery<number>(["x"], () => registry.rpc<number>("get", {}));
      if (typeof q.data === "number") observed.push(q.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => observed[observed.length - 1] === 1);

    await act(async () => {
      registry.setQueryData(["x"], 99);
    });
    await waitFor(() => observed[observed.length - 1] === 99);

    await harness.unmount();
  });
});

describe("useGatewayQuery params", () => {
  test("params changes do not reuse stale data when the caller key is stable", async () => {
    const calls: unknown[] = [];
    const registry = createGatewayCollections({
      client: makeTransport((method, params) => {
        calls.push({ method, params });
        return Promise.resolve({ id: (params as { id: string }).id, call: calls.length });
      }).transport,
    });

    let latest: { id: string; call: number } | undefined;
    function Probe({ id }: { id: string }) {
      const q = useGatewayQuery<{ id: string; call: number }>(["gateway:getThing"], "getThing", { id });
      latest = q.data;
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe, { id: "a" })));
    await waitFor(() => latest?.id === "a");
    expect(latest).toEqual({ id: "a", call: 1 });

    await harness.render(provider(registry, createElement(Probe, { id: "b" })));
    expect(latest?.id).not.toBe("a");
    await waitFor(() => latest?.id === "b");
    expect(calls).toEqual([{ method: "getThing", params: { id: "a" } }, { method: "getThing", params: { id: "b" } }]);

    await harness.unmount();
  });
});

describe("useSyncMutation optimistic + rollback", () => {
  test("rolls back optimistic data when the runner rejects", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "readCounter") return Promise.resolve(5);
        return Promise.reject(new Error("bump failed"));
      }).transport,
    });

    const seen: number[] = [];
    let mutate: (vars: number) => Promise<number> = async () => 0;
    function Probe() {
      const q = useSyncQuery<number>(["counter"], () => registry.rpc<number>("readCounter", {}));
      const m = useSyncMutation<number, number, number | undefined>(
        (next) => registry.rpc<number>("bump", { next }),
        {
          onMutate: (next) => registry.setQueryData<number>(["counter"], next).previous,
          onError: (_err, _vars, previous) => {
            if (typeof previous === "number") registry.setQueryData(["counter"], previous);
          },
        },
      );
      mutate = m.mutate;
      if (typeof q.data === "number") seen.push(q.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => seen[seen.length - 1] === 5);

    await act(async () => {
      await mutate(99).catch(() => undefined);
    });
    await settle();
    // Optimistic 99 was written then rolled back to 5 on rejection.
    expect(seen).toContain(99);
    expect(seen[seen.length - 1]).toBe(5);

    await harness.unmount();
  });
});

describe("useSyncMutation success path", () => {
  test("sets status to success and returns data after the runner resolves", async () => {
    const registry = createGatewayCollections({
      client: makeTransport(() => Promise.resolve({ value: 42 })).transport,
    });

    let mutation: ReturnType<typeof useSyncMutation<void, { value: number }>> | undefined;
    function Probe() {
      mutation = useSyncMutation<void, { value: number }>(() => registry.rpc("get", {}));
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    await act(async () => {
      await mutation?.mutate(undefined as unknown as void);
    });
    await settle();

    expect(mutation?.status).toBe("success");
    expect(mutation?.data).toEqual({ value: 42 });
    expect(mutation?.error).toBeUndefined();
    expect(mutation?.isLoading).toBe(false);

    await harness.unmount();
  });

  test("calls onSuccess with data, vars, context, and registry after the runner resolves", async () => {
    const registry = createGatewayCollections({
      client: makeTransport(() => Promise.resolve("done")).transport,
    });

    const calls: Array<{ data: string; vars: number; context: string; registry: GatewayCollections }> = [];
    let mutation: ReturnType<typeof useSyncMutation<number, string, string>> | undefined;
    function Probe() {
      mutation = useSyncMutation<number, string, string>(
        () => registry.rpc("run", {}),
        {
          onMutate: (vars) => `ctx-${vars}`,
          onSuccess: (data, vars, context, successRegistry) => {
            calls.push({ data, vars, context, registry: successRegistry });
          },
        },
      );
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    await act(async () => {
      await mutation?.mutate(7);
    });
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ data: "done", vars: 7, context: "ctx-7", registry });

    await harness.unmount();
  });

  test("invalidates the specified keys after a successful mutation", async () => {
    let fetchCount = 0;
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "readCounter") return Promise.resolve(++fetchCount);
        return Promise.resolve("ok");
      }).transport,
    });

    const seen: number[] = [];
    let mutation: ReturnType<typeof useSyncMutation<void, string>> | undefined;
    function Probe() {
      const q = useSyncQuery<number>(["counter"], () => registry.rpc<number>("readCounter", {}));
      mutation = useSyncMutation<void, string>(
        () => registry.rpc("bump", {}),
        { invalidate: [["counter"]] },
      );
      if (typeof q.data === "number") seen.push(q.data);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => seen[seen.length - 1] === 1);

    await act(async () => {
      await mutation?.mutate(undefined as unknown as void);
    });
    await waitFor(() => seen[seen.length - 1] === 2);

    expect(fetchCount).toBeGreaterThanOrEqual(2);

    await harness.unmount();
  });

  test("reset() returns status to idle and clears data", async () => {
    const registry = createGatewayCollections({
      client: makeTransport(() => Promise.resolve("result")).transport,
    });

    let mutation: ReturnType<typeof useSyncMutation<void, string>> | undefined;
    function Probe() {
      mutation = useSyncMutation<void, string>(() => registry.rpc("run", {}));
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    await act(async () => {
      await mutation?.mutate(undefined as unknown as void);
    });
    await settle();
    expect(mutation?.status).toBe("success");
    expect(mutation?.data).toBe("result");

    await act(async () => {
      mutation?.reset();
    });
    await settle();
    expect(mutation?.status).toBe("idle");
    expect(mutation?.data).toBeUndefined();
    expect(mutation?.error).toBeUndefined();

    await harness.unmount();
  });

  test("mutateSafe returns data on success and does not throw", async () => {
    const registry = createGatewayCollections({
      client: makeTransport(() => Promise.resolve({ ok: true })).transport,
    });

    let mutation: ReturnType<typeof useSyncMutation<void, { ok: boolean }>> | undefined;
    function Probe() {
      mutation = useSyncMutation<void, { ok: boolean }>(() => registry.rpc("run", {}));
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await mutation?.mutateSafe(undefined as unknown as void);
    });
    await settle();

    expect(result).toEqual({ ok: true });
    expect(mutation?.status).toBe("success");

    await harness.unmount();
  });
});

describe("useGatewayMutation", () => {
  test("runs the named gateway RPC and exposes success state", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const registry = createGatewayCollections({
      client: makeTransport((method, params) => {
        calls.push({ method, params });
        return Promise.resolve({ runId: (params as { runId: string }).runId, accepted: true });
      }).transport,
    });

    let mutation: ReturnType<typeof useGatewayMutation<{ runId: string }, { runId: string; accepted: boolean }>> | undefined;
    function Probe() {
      mutation = useGatewayMutation<{ runId: string }, { runId: string; accepted: boolean }>("approveRun");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    await act(async () => {
      await mutation?.mutate({ runId: "run-1" });
    });
    await settle();

    expect(calls).toEqual([{ method: "approveRun", params: { runId: "run-1" } }]);
    expect(mutation?.status).toBe("success");
    expect(mutation?.data).toEqual({ runId: "run-1", accepted: true });
    expect(mutation?.error).toBeUndefined();

    await harness.unmount();
  });

  test("surfaces gateway RPC errors through mutateSafe", async () => {
    const registry = createGatewayCollections({
      client: makeTransport(() => Promise.reject(new Error("approval denied"))).transport,
    });

    let mutation: ReturnType<typeof useGatewayMutation<{ runId: string }, { ok: boolean }>> | undefined;
    function Probe() {
      mutation = useGatewayMutation<{ runId: string }, { ok: boolean }>("approveRun");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await mutation?.mutateSafe({ runId: "run-1" });
    });
    await settle();

    expect(result).toBeUndefined();
    expect(mutation?.status).toBe("error");
    expect(mutation?.error?.message).toBe("approval denied");

    await harness.unmount();
  });
});

describe("useSyncSubscription frames + backpressure", () => {
  test("frames pushed by the transport appear in the bounded buffer", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let last: SyncStreamFrame | undefined;
    function Probe() {
      const r = useSyncSubscription(gatewayKeys.runEvents("r1"), "streamRunEvents", { runId: "r1" }, { maxFrames: 3 });
      last = r.last;
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      stream.push("streamRunEvents", "r1", { key: ["run", "r1"], seq: 1, event: "run.event", payload: { v: 1 } });
    });
    await waitFor(() => last?.seq === 1);

    await act(async () => {
      stream.push("streamRunEvents", "r1", { key: ["run", "r1"], seq: 2, event: "run.event", payload: { v: 2 } });
      stream.push("streamRunEvents", "r1", { key: ["run", "r1"], seq: 3, event: "run.event", payload: { v: 3 } });
    });
    await waitFor(() => last?.seq === 3);

    await harness.unmount();
  });

  test("frames past maxFrames push older ones out", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let result: UseSyncSubscriptionResult | undefined;
    function Probe() {
      result = useSyncSubscription(gatewayKeys.runEvents("flood"), "streamRunEvents", { runId: "flood" }, { maxFrames: 3 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      for (let seq = 1; seq <= 6; seq += 1) {
        stream.push("streamRunEvents", "flood", { key: ["run", "flood"], seq, event: "run.event", payload: { seq } });
      }
    });
    await waitFor(() => result?.frames.length === 3 && result.frames[2]?.seq === 6);
    expect(result?.frames.map((f) => f.seq)).toEqual([4, 5, 6]);
    expect(result?.dropped).toBeGreaterThanOrEqual(3);

    await harness.unmount();
  });

  test("params changes open a fresh stream and reset frames", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let result: UseSyncSubscriptionResult | undefined;
    function Probe({ runId }: { runId: string }) {
      result = useSyncSubscription(gatewayKeys.runEvents(runId), "streamRunEvents", { runId }, { maxFrames: 3 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe, { runId: "r1" })));
    await waitFor(() => stream.opens.some((o) => String((o.params as { runId?: string }).runId) === "r1"));

    await act(async () => {
      stream.push("streamRunEvents", "r1", { key: ["run", "r1"], seq: 1, event: "run.event", payload: { runId: "r1" } });
    });
    await waitFor(() => result?.last?.payload !== undefined);

    await harness.render(provider(registry, createElement(Probe, { runId: "r2" })));
    await waitFor(() => result?.frames.length === 0);
    await waitFor(() => stream.opens.some((o) => String((o.params as { runId?: string }).runId) === "r2"));

    await harness.unmount();
  });
});

describe("useGatewayRunStream", () => {
  test("subscribes to streamRunEvents for the provided run id", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let result: ReturnType<typeof useGatewayRunStream> | undefined;
    function Probe() {
      result = useGatewayRunStream("run-1", { maxFrames: 2 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);
    expect(stream.opens[0]).toMatchObject({
      scope: "streamRunEvents",
      params: { runId: "run-1" },
    });

    await act(async () => {
      stream.push("streamRunEvents", "run-1", { key: gatewayKeys.runEvents("run-1"), seq: 1, event: "run.event", payload: { seq: 1 } });
      stream.push("streamRunEvents", "run-1", { key: gatewayKeys.runEvents("run-1"), seq: 2, event: "run.event", payload: { seq: 2 } });
      stream.push("streamRunEvents", "run-1", { key: gatewayKeys.runEvents("run-1"), seq: 3, event: "run.event", payload: { seq: 3 } });
    });
    await waitFor(() => result?.last?.seq === 3);

    expect(result?.frames.map((frame) => frame.seq)).toEqual([2, 3]);
    expect(result?.dropped).toBeGreaterThanOrEqual(1);

    await harness.unmount();
  });

  test("does not open a stream when no run id is provided", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let result: ReturnType<typeof useGatewayRunStream> | undefined;
    function Probe() {
      result = useGatewayRunStream(undefined);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await settle();

    expect(stream.opens).toHaveLength(0);
    expect(result?.frames).toEqual([]);
    expect(result?.last).toBeUndefined();
    expect(result?.dropped).toBe(0);

    await harness.unmount();
  });
});

describe("legacy synced hooks over collections", () => {
  test("list hook refetch callbacks depend on params", () => {
    const hooks = [
      "useGatewayApprovals.ts",
      "useGatewayRuns.ts",
      "useGatewayWorkflows.ts",
    ];

    for (const hook of hooks) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../src/${hook}`, import.meta.url)),
        "utf8",
      );
      expect(source).toContain("const refetch = useCallback(async () => {");
      expect(source).toMatch(/\}, \[[^\]]*\bparams\b[^\]]*\]\);/);
    }
  });

  test("useGatewayRuns lists rows from listRuns", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([{ runId: "run-1", status: "running" }]);
        return Promise.resolve([]);
      }).transport,
    });

    let snapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function Probe() {
      snapshot = useGatewayRuns();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (snapshot?.data?.length ?? 0) === 1);
    expect((snapshot?.data?.[0] as { runId?: string }).runId).toBe("run-1");
    expect(snapshot?.loading).toBe(false);

    await harness.unmount();
  });

  test("useGatewayRun upserts run status from a streamRunEvents lifecycle frame", async () => {
    const stream = makeTransport((method) => {
      if (method === "getRun") return Promise.resolve({ runId: "run-1", status: "running" });
      return Promise.resolve({});
    });
    const registry = createGatewayCollections({ client: stream.transport });

    let snapshot: ReturnType<typeof useGatewayRun> | undefined;
    function Probe() {
      snapshot = useGatewayRun("run-1");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (snapshot?.data as { status?: string })?.status === "running");

    await act(async () => {
      stream.push("streamRunEvents", "run-1", {
        key: gatewayKeys.runEvents("run-1"),
        seq: 7,
        event: "run.lifecycle",
        payload: { event: "run.completed", payload: { state: "ok" } },
      });
    });
    await waitFor(() => (snapshot?.data as { status?: string })?.status === "ok");

    await harness.unmount();
  });

  test("useGatewayApprovals and useGatewayWorkflows surface their lists", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listApprovals") {
          return Promise.resolve([{ runId: "run-1", nodeId: "approve", iteration: 0, requestedAtMs: 1 }]);
        }
        if (method === "listWorkflows") return Promise.resolve([{ key: "deploy", hasUi: true, uiPath: "/x" }]);
        return Promise.resolve([]);
      }).transport,
    });

    let approvals: ReturnType<typeof useGatewayApprovals> | undefined;
    let workflows: ReturnType<typeof useGatewayWorkflows> | undefined;
    function Probe() {
      approvals = useGatewayApprovals({ filter: { runId: "run-1" } });
      workflows = useGatewayWorkflows({ filter: { hasUi: true } });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (approvals?.data?.length ?? 0) === 1 && (workflows?.data?.length ?? 0) === 1);
    expect(approvals?.data?.[0]?.nodeId).toBe("approve");
    expect(workflows?.data?.[0]?.key).toBe("deploy");

    await harness.unmount();
  });

  test("useGatewayCrons lists rows from cronList (enabled + disabled)", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "cronList") {
          return Promise.resolve([
            { cronId: "cron-1", workflow: "deploy", workflowPath: ".smithers/workflows/deploy.tsx", pattern: "0 8 * * 1-5", enabled: true },
            { cronId: "cron-2", workflow: "canary", workflowPath: ".smithers/workflows/canary.tsx", pattern: "*/15 * * * *", enabled: false },
          ]);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let crons: ReturnType<typeof useGatewayCrons> | undefined;
    function Probe() {
      crons = useGatewayCrons();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (crons?.data?.length ?? 0) === 2);
    expect(crons?.data?.map((row) => row.cronId).sort()).toEqual(["cron-1", "cron-2"]);
    expect(crons?.data?.find((row) => row.cronId === "cron-2")?.enabled).toBe(false);
    expect(crons?.loading).toBe(false);

    await harness.unmount();
  });

  test("useGatewayMemoryFacts lists rows from listMemoryFacts (namespace-scoped)", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method, params) => {
        if (method === "listMemoryFacts") {
          const ns = (params as { namespace?: string } | undefined)?.namespace;
          const all = [
            { namespace: "ci", key: "token-ttl-rotation", valueJson: '"fixed ttl"', schemaSig: null, createdAtMs: 1, updatedAtMs: 2, ttlMs: 3_600_000 },
            { namespace: "auth", key: "session-sync-signing", valueJson: '{"sync":true}', schemaSig: null, createdAtMs: 1, updatedAtMs: 2, ttlMs: null },
          ];
          return Promise.resolve(ns ? all.filter((row) => row.namespace === ns) : all);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let facts: ReturnType<typeof useGatewayMemoryFacts> | undefined;
    function Probe() {
      facts = useGatewayMemoryFacts("ci");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (facts?.data?.length ?? 0) === 1);
    expect(facts?.data?.map((row) => row.key)).toEqual(["token-ttl-rotation"]);
    expect(facts?.data?.[0]?.namespace).toBe("ci");
    expect(facts?.data?.[0]?.ttlMs).toBe(3_600_000);
    expect(facts?.loading).toBe(false);

    await harness.unmount();
  });

  test("useGatewayPrompts lists rows from listPrompts (walked from .smithers/prompts/)", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listPrompts") {
          return Promise.resolve([
            { id: "refactor", entryFile: "prompts/refactor.mdx", source: "# Refactor", createdAtMs: 1, updatedAtMs: 2 },
            { id: "release-content/changelog", entryFile: "prompts/release-content/changelog.md", source: "# Changelog", createdAtMs: 1, updatedAtMs: 2 },
          ]);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let prompts: ReturnType<typeof useGatewayPrompts> | undefined;
    function Probe() {
      prompts = useGatewayPrompts();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (prompts?.data?.length ?? 0) === 2);
    expect(prompts?.data?.map((row) => row.id).sort()).toEqual(["refactor", "release-content/changelog"]);
    expect(prompts?.data?.find((row) => row.id === "refactor")?.entryFile).toBe("prompts/refactor.mdx");
    expect(prompts?.loading).toBe(false);

    await harness.unmount();
  });

  test("useGatewayScores lists scorer rows from listScores (run-scoped)", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method, params) => {
        if (method === "listScores") {
          const runId = (params as { runId?: string } | undefined)?.runId;
          if (runId !== "run_7a3f") return Promise.resolve([]);
          return Promise.resolve([
            { runId: "run_7a3f", nodeId: "review", iteration: 0, attempt: 0, scorerId: "correctness", scorerName: "correctness", source: "scorer", score: 0.92, reason: "ok", scoredAtMs: 10, latencyMs: 4_120, durationMs: null },
            { runId: "run_7a3f", nodeId: "review", iteration: 1, attempt: 0, scorerId: "correctness", scorerName: "correctness", source: "scorer", score: 0.88, reason: null, scoredAtMs: 20, latencyMs: null, durationMs: null },
          ]);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let scores: ReturnType<typeof useGatewayScores> | undefined;
    function Probe() {
      scores = useGatewayScores("run_7a3f");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (scores?.data?.length ?? 0) === 2);
    expect(scores?.data?.map((row) => row.score).sort()).toEqual([0.88, 0.92]);
    expect(scores?.data?.every((row) => row.runId === "run_7a3f")).toBe(true);
    expect(scores?.loading).toBe(false);

    await harness.unmount();
  });

  test("useGatewayTickets lists live work docs from listTickets (keyed by path)", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listTickets") {
          return Promise.resolve([
            { path: "feat-issues-card", kind: "ticket", content: "# Issues card", contentHash: "a".repeat(64), status: "in-progress", updatedAtMs: 20 },
            { path: "docs-markdown-editor", kind: "ticket", content: "# Docs", contentHash: "b".repeat(64), status: null, updatedAtMs: 10 },
          ]);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let tickets: ReturnType<typeof useGatewayTickets> | undefined;
    function Probe() {
      tickets = useGatewayTickets();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (tickets?.data?.length ?? 0) === 2);
    expect(tickets?.data?.map((row) => row.path).sort()).toEqual(["docs-markdown-editor", "feat-issues-card"]);
    expect(tickets?.data?.find((row) => row.path === "feat-issues-card")?.status).toBe("in-progress");
    expect(tickets?.loading).toBe(false);

    await harness.unmount();
  });
});

describe("useGatewayRunEvents over the runEvents collection", () => {
  test("filters heartbeats into lastHeartbeat and caps the events array", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("run-1", { maxEvents: 5 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      for (let seq = 1; seq <= 8; seq += 1) {
        stream.push("streamRunEvents", "run-1", {
          key: gatewayKeys.runEvents("run-1"),
          seq,
          event: "run.event",
          payload: { seq },
        });
        if (seq === 3) {
          stream.push("streamRunEvents", "run-1", {
            key: gatewayKeys.runEvents("run-1"),
            seq: 103,
            event: "run.heartbeat",
            payload: {},
          });
        }
        if (seq === 6) {
          stream.push("streamRunEvents", "run-1", {
            key: gatewayKeys.runEvents("run-1"),
            seq: 106,
            event: "run.heartbeat",
            payload: {},
          });
        }
      }
    });

    await waitFor(() => snapshot?.events.length === 5 && snapshot?.lastHeartbeat?.seq === 106);
    expect(snapshot?.events.every((f) => f.event !== "run.heartbeat")).toBe(true);
    expect(snapshot?.events.map((f) => f.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(snapshot?.streaming).toBe(true);

    await harness.unmount();
  });

  test("filters run events at or before afterSeq", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("run-1", { afterSeq: 2 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      for (let seq = 1; seq <= 4; seq += 1) {
        stream.push("streamRunEvents", "run-1", {
          key: gatewayKeys.runEvents("run-1"),
          seq,
          event: seq === 2 ? "run.heartbeat" : "run.event",
          payload: { seq },
        });
      }
    });

    await waitFor(() => snapshot?.events.length === 2);
    expect(snapshot?.events.map((frame) => frame.seq)).toEqual([3, 4]);
    expect(snapshot?.lastHeartbeat).toBeUndefined();

    await harness.unmount();
  });

  test("reports an error and stops streaming when the run event stream fails", async () => {
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({ client: stream.transport });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("run-1");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      stream.fail("streamRunEvents", "run-1", new Error("stream failed"));
    });

    await waitFor(() => snapshot?.error?.message === "Run event stream failed.");
    expect(snapshot?.streaming).toBe(false);

    await harness.unmount();
  });
});

describe("useGatewayRunTree reconcile", () => {
  test("a devtools frame upserts changed nodes and deletes removed ones", async () => {
    const snapshots = [
      {
        root: {
          id: 0,
          name: "Workflow",
          type: "Workflow",
          children: [
            { id: 1, name: "a", type: "Task", task: { nodeId: "a" } },
            { id: 2, name: "b", type: "Task", task: { nodeId: "b" } },
          ],
        },
        runState: { state: "running" },
      },
      {
        root: {
          id: 0,
          name: "Workflow",
          type: "Workflow",
          children: [
            { id: 1, name: "a", type: "Task", task: { nodeId: "a" } },
            { id: 3, name: "c", type: "Task", task: { nodeId: "c" } },
          ],
        },
        runState: { state: "running" },
      },
    ];
    const stream = makeTransport((method) => {
      if (method === "getDevToolsSnapshot") {
        return Promise.resolve(snapshots.shift() ?? snapshots[snapshots.length - 1]);
      }
      return Promise.resolve({});
    });
    const registry = createGatewayCollections({ client: stream.transport });

    let tree: ReturnType<typeof useGatewayRunTree> | undefined;
    function Probe() {
      tree = useGatewayRunTree("run-1");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => tree?.nodes.some((n) => n.id === "b") === true);
    expect(
      tree?.nodes
        .map((n) => n.id)
        .slice()
        .sort(),
    ).toEqual(["0", "a", "b"]);
    expect(tree?.root?.children?.map((c) => c.id)).toEqual(["a", "b"]);

    await act(async () => {
      stream.push("streamDevTools", "run-1", {
        key: gatewayKeys.devtools("run-1"),
        seq: 4,
        event: "devtools.event",
        payload: { kind: "changed" },
      });
    });

    await waitFor(() => tree?.nodes.some((n) => n.id === "c") === true);
    expect(tree?.nodes.some((n) => n.id === "b")).toBe(false);
    expect(tree?.root?.children?.map((c) => c.id)).toEqual(["a", "c"]);

    await harness.unmount();
  });
});

describe("invalidate() re-pull of pollable list collections via the pulser", () => {
  test("invalidate() triggers a fresh RPC fetch and re-renders with updated data", async () => {
    let callCount = 0;
    const responses: Array<Array<{ runId: string; status: string }>> = [
      [{ runId: "run-1", status: "running" }],
      [{ runId: "run-1", status: "completed" }, { runId: "run-2", status: "running" }],
    ];
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") {
          const batch = responses[callCount] ?? responses[responses.length - 1];
          callCount += 1;
          return Promise.resolve(batch);
        }
        return Promise.resolve([]);
      }).transport,
    });

    let snapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function Probe() {
      snapshot = useGatewayRuns();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (snapshot?.data?.length ?? 0) === 1);
    expect((snapshot?.data?.[0] as { runId?: string }).runId).toBe("run-1");
    expect((snapshot?.data?.[0] as { status?: string }).status).toBe("running");

    // Invalidate should pulse the collection's fingerprint through the pulser,
    // causing the INVALIDATE_SCOPE pseudo-stream to yield a frame, which triggers
    // refetchOnFrame and fires a fresh listRuns RPC.
    await act(async () => {
      await registry.invalidate(gatewayKeys.runs({}));
    });

    await waitFor(() => (snapshot?.data?.length ?? 0) === 2);
    const statuses = snapshot?.data?.map((r) => (r as { status?: string }).status).sort();
    expect(statuses).toEqual(["completed", "running"]);

    await harness.unmount();
  });
});

describe("useGatewayConnectionStatus", () => {
  test("goes online on a successful load and unauthorized on an auth error", async () => {
    let authMessage = "";
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.reject(new Error("UNAUTHORIZED: missing token"));
      }).transport,
      onAuthError: (error) => {
        authMessage = error.message;
      },
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "online");
    expect(status?.isOnline).toBe(true);

    // A failing auth RPC flips the observer to unauthorized and fires onAuthError.
    await act(async () => {
      await registry.rpc("getRun", { runId: "x" }).catch(() => undefined);
    });
    await waitFor(() => status?.status === "unauthorized");
    expect(authMessage).toMatch(/UNAUTHORIZED/);

    await harness.unmount();
  });

  test("connect() probes the gateway and reset() clears the observer", async () => {
    const calls: string[] = [];
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        calls.push(method);
        return Promise.resolve([]);
      }).transport,
    });

    expect(registry.connection().status).toBe("idle");
    await registry.connect();
    expect(calls).toContain("listRuns");
    expect(registry.connection().status).toBe("online");

    registry.reset();
    expect(registry.connection().status).toBe("idle");
  });

  test("markConnecting transitions idle→connecting, then online on success", async () => {
    let resolve!: (v: unknown[]) => void;
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return new Promise((r) => { resolve = r; });
        return Promise.resolve([]);
      }).transport,
    });

    expect(registry.connection().status).toBe("idle");

    // Kick off a live RPC — the transport wraps rpc with markConnecting() before awaiting.
    const pending = registry.rpc("listRuns", {});
    // Give the microtask queue a tick so markConnecting() has fired.
    await Promise.resolve();
    expect(registry.connection().status).toBe("connecting");

    resolve([]);
    await pending;
    expect(registry.connection().status).toBe("online");
  });

  test("markOffline sets status and preserves reconnectingSince across repeated failures", async () => {
    let callCount = 0;
    const registry = createGatewayCollections({
      client: makeTransport(() => {
        callCount += 1;
        return Promise.reject(new Error("network error"));
      }).transport,
    });

    // First failure: status goes offline and reconnectingSince is stamped.
    await registry.rpc("listRuns", {}).catch(() => undefined);
    const state1 = registry.connection();
    expect(state1.status).toBe("offline");
    expect(typeof state1.reconnectingSince).toBe("number");
    const since = state1.reconnectingSince!;

    // Second failure: reconnectingSince must be preserved (not re-stamped).
    await registry.rpc("listRuns", {}).catch(() => undefined);
    const state2 = registry.connection();
    expect(state2.status).toBe("offline");
    expect(state2.reconnectingSince).toBe(since);
  });

  test("useGatewayConnectionStatus reflects offline state and reconnectingSince reactively", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.reject(new Error("network error"));
        return Promise.resolve([]);
      }).transport,
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "offline");
    expect(status?.isOnline).toBe(false);
    expect(typeof status?.reconnectingSince).toBe("number");

    await harness.unmount();
  });

  test("treats HTTP 401 status on an error object as an auth error", async () => {
    let authFired = false;
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.reject(err);
      }).transport,
      onAuthError: () => { authFired = true; },
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "online");

    await act(async () => {
      await registry.rpc("getRun", { runId: "x" }).catch(() => undefined);
    });
    await waitFor(() => status?.status === "unauthorized");
    expect(authFired).toBe(true);
    await harness.unmount();
  });

  test("treats HTTP 403 status on an error object as an auth error", async () => {
    let authFired = false;
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.reject(err);
      }).transport,
      onAuthError: () => { authFired = true; },
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "online");

    await act(async () => {
      await registry.rpc("getRun", { runId: "x" }).catch(() => undefined);
    });
    await waitFor(() => status?.status === "unauthorized");
    expect(authFired).toBe(true);
    await harness.unmount();
  });

  test("treats UNAUTHORIZED code on an error object as an auth error", async () => {
    let authFired = false;
    const err = Object.assign(new Error("some rpc error"), { code: "Unauthorized" });
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.reject(err);
      }).transport,
      onAuthError: () => { authFired = true; },
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "online");

    await act(async () => {
      await registry.rpc("getRun", { runId: "x" }).catch(() => undefined);
    });
    await waitFor(() => status?.status === "unauthorized");
    expect(authFired).toBe(true);
    await harness.unmount();
  });

  test("treats FORBIDDEN code on an error object as an auth error", async () => {
    let authFired = false;
    const err = Object.assign(new Error("some rpc error"), { code: "Forbidden" });
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.reject(err);
      }).transport,
      onAuthError: () => { authFired = true; },
    });

    let status: ReturnType<typeof useGatewayConnectionStatus> | undefined;
    function Probe() {
      useGatewayRuns();
      status = useGatewayConnectionStatus();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => status?.status === "online");

    await act(async () => {
      await registry.rpc("getRun", { runId: "x" }).catch(() => undefined);
    });
    await waitFor(() => status?.status === "unauthorized");
    expect(authFired).toBe(true);
    await harness.unmount();
  });
});

describe("useSyncClient and SyncContext", () => {
  test("useSyncClient throws with a descriptive message when used outside SyncProvider", () => {
    function Probe() {
      useSyncClient();
      return null;
    }

    expect(() => renderToString(createElement(Probe))).toThrow(
      "useSyncClient: missing <SyncProvider>. Wrap your tree in a SyncProvider.",
    );
  });

  test("SyncContext default value is null (no-provider baseline)", () => {
    let captured: unknown = "not-set";

    function Probe() {
      captured = useContext(SyncContext);
      return null;
    }

    renderToString(createElement(Probe));

    expect(captured).toBeNull();
  });
});
