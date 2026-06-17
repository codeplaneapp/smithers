// Drives the real sync hooks through React's real reconciler under a real DOM
// (happy-dom) so TanStack DB's `useLiveQuery` actually subscribes and
// re-renders. The collections, registry, and reconcile logic are the real ones;
// the only seam is a fake `SyncTransport` whose rpc/stream handlers return real
// promises and real async iterables (no hook logic is faked).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom errors if registered twice across test files in the same bun run.
if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  gatewayKeys,
  type SyncStreamFrame,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import {
  SyncProvider,
  createGatewayCollections,
  useGatewayApprovals,
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
  type Channel = { queue: SyncStreamFrame[]; waiters: Array<() => void>; ended: boolean };
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
});
