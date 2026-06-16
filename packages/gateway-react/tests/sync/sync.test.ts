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

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createGatewaySyncSource,
  gatewayKeys,
  gatewayCollectionDefs,
  syncKeyFingerprint,
  type SyncTelemetryEvent,
  type SyncStreamFrame,
  type SyncTransport,
} from "@smithers-orchestrator/gateway-client";
import {
  SyncProvider,
  createGatewayCollections,
  createMemoryPersistenceAdapter,
  useGatewayApprovals,
  useGatewayConnectionStatus,
  useGatewayMutation,
  useGatewayQuery,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
  useGatewayTickets,
  useGatewayWorkflows,
  useSyncMutation,
  useSyncQuery,
  useSyncSubscription,
  type GatewayCollections,
  type UseSyncSubscriptionResult,
} from "../../src/index.ts";
// Native-only adapter: imported via its module, never the browser-safe barrel.
import { createBunSqlitePersistenceAdapter } from "../../src/bunSqlitePersistenceAdapter.ts";
import { createFakeElectricSyncSource } from "./fakeElectricSyncSource.ts";

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

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await predicate()) return;
    await settle(2);
  }
  expect(await predicate()).toBe(true);
}

const tmpPersistenceDirs: string[] = [];
function tmpSqlitePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "smithers-sync-persist-"));
  tmpPersistenceDirs.push(dir);
  return join(dir, "client.sqlite");
}
afterAll(() => {
  for (const dir of tmpPersistenceDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function installSyncTelemetry(events: SyncTelemetryEvent[], spans: Array<{ name: string; attributes: Record<string, unknown> }>) {
  const host = globalThis as {
    __smithersSyncTelemetry?: {
      event?: (event: SyncTelemetryEvent) => void;
      span?: (span: { name: string; attributes: Record<string, unknown> }) => void;
    };
  };
  const previous = host.__smithersSyncTelemetry;
  host.__smithersSyncTelemetry = {
    event: (event) => events.push(event),
    span: (span) => spans.push(span),
  };
  return () => {
    host.__smithersSyncTelemetry = previous;
  };
}

/** Mount a hook over one registry and wait until its value satisfies `done`. */
async function assertOverSource<T>(
  registry: GatewayCollections,
  useHook: () => T,
  done: (value: T) => boolean,
): Promise<void> {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  const harness = await mountHarness();
  await harness.render(provider(registry, createElement(Probe)));
  await waitFor(() => value !== undefined && done(value));
  await harness.unmount();
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

describe("useGatewayMutation optimistic transactions", () => {
  test("launchRun writes an optimistic run and marks it synced after gateway confirmation", async () => {
    const events: SyncTelemetryEvent[] = [];
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const restoreTelemetry = installSyncTelemetry(events, spans);
    let launchedRunId: string | undefined;
    let resolveLaunch: (() => void) | undefined;
    const transport = makeTransport((method, params) => {
      if (method === "listRuns") {
        return Promise.resolve(
          launchedRunId
            ? [{ runId: launchedRunId, workflowKey: "deploy", status: "running", createdAtMs: 1 }]
            : [],
        );
      }
      if (method === "launchRun") {
        const options = (params as { options?: { runId?: string } }).options ?? {};
        launchedRunId = options.runId;
        return new Promise((resolve) => {
          resolveLaunch = () => resolve({ runId: launchedRunId, workflow: "deploy" });
        });
      }
      return Promise.resolve({});
    });
    const registry = createGatewayCollections({ client: transport.transport });

    const snapshots: Array<Array<{ runId: string; synced: boolean | undefined; status: string | undefined }>> = [];
    let runsReady = false;
    let launch: (vars: { workflow: string; input: Record<string, unknown> }) => Promise<{ runId?: string }> = async () => ({});
    function Probe() {
      const runs = useGatewayRuns();
      const mutation = useGatewayMutation<{ workflow: string; input: Record<string, unknown> }, { runId?: string }>(
        "launchRun",
      );
      launch = mutation.mutate;
      runsReady = !runs.loading;
      snapshots.push(
        (runs.data ?? []).map((row) => ({
          runId: row.runId,
          synced: row.$synced,
          status: row.status,
        })),
      );
      return null;
    }

    const harness = await mountHarness();
    try {
      await harness.render(provider(registry, createElement(Probe)));
      await waitFor(() => runsReady && snapshots[snapshots.length - 1]?.length === 0);

      let pending!: Promise<{ runId?: string }>;
      await act(async () => {
        pending = launch({ workflow: "deploy", input: {} });
        await settle();
      });
      await waitFor(() => snapshots.some((rows) => rows.some((row) => row.synced === false)));
      expect(typeof launchedRunId).toBe("string");

      await act(async () => {
        resolveLaunch?.();
        await pending;
      });
      await waitFor(() =>
        snapshots.some((rows) => rows.some((row) => row.runId === launchedRunId && row.synced === true)),
      );
      await waitFor(() => events.some((event) => event.type === "sync.mutation.confirm"));
      expect(events.some((event) => event.type === "sync.mutation.optimistic_apply")).toBe(true);
      expect(events.some((event) => event.type === "sync.mutation.handler_rpc" && event.method === "launchRun")).toBe(true);
      expect(spans.some((span) => span.name === "smithers.sync.mutation.confirm")).toBe(true);
    } finally {
      restoreTelemetry();
      await harness.unmount();
    }
  });

  test("submitApproval keeps the row visibly pending until the gateway refetch confirms it", async () => {
    let approved = false;
    let resolveApproval: (() => void) | undefined;
    const approval = {
      runId: "run-1",
      nodeId: "approve",
      iteration: 0,
      requestedAtMs: 1,
      requestTitle: "Ship it",
    };
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listApprovals") return Promise.resolve(approved ? [] : [approval]);
        if (method === "submitApproval") {
          return new Promise((resolve) => {
            resolveApproval = () => {
              approved = true;
              resolve({ runId: "run-1", nodeId: "approve", iteration: 0, approved: true });
            };
          });
        }
        if (method === "listRuns") return Promise.resolve([]);
        return Promise.resolve({});
      }).transport,
    });

    const snapshots: Array<Array<{ synced: boolean | undefined; status: string | undefined }>> = [];
    let approvalsReady = false;
    let submit: (vars: {
      runId: string;
      nodeId: string;
      iteration: number;
      decision: { approved: boolean };
    }) => Promise<unknown> = async () => undefined;
    function Probe() {
      const approvals = useGatewayApprovals({ filter: { runId: "run-1" } });
      const mutation = useGatewayMutation<{
        runId: string;
        nodeId: string;
        iteration: number;
        decision: { approved: boolean };
      }>("submitApproval");
      submit = mutation.mutate;
      approvalsReady = !approvals.loading;
      snapshots.push((approvals.data ?? []).map((row) => ({ synced: row.$synced, status: row.status })));
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => approvalsReady && snapshots.some((rows) => rows.length === 1 && rows[0]?.synced === true));

    let pending!: Promise<unknown>;
    await act(async () => {
      pending = submit({
        runId: "run-1",
        nodeId: "approve",
        iteration: 0,
        decision: { approved: true },
      });
      await settle();
    });
    await waitFor(() => snapshots.some((rows) => rows.some((row) => row.synced === false && row.status === "approved")));

    await act(async () => {
      resolveApproval?.();
      await pending;
    });
    await waitFor(() => snapshots[snapshots.length - 1]?.length === 0);
    await harness.unmount();
  });

  test("rolls back the optimistic run when the gateway RPC rejects", async () => {
    const events: SyncTelemetryEvent[] = [];
    const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    const restoreTelemetry = installSyncTelemetry(events, spans);
    let rejectLaunch: ((error: Error) => void) | undefined;
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([]);
        if (method === "launchRun") {
          return new Promise((_resolve, reject) => {
            rejectLaunch = reject;
          });
        }
        return Promise.resolve({});
      }).transport,
    });

    const snapshots: Array<Array<{ synced: boolean | undefined }>> = [];
    let runsReady = false;
    let launch: (vars: { workflow: string; input: Record<string, unknown> }) => Promise<unknown> = async () => undefined;
    function Probe() {
      const runs = useGatewayRuns();
      const mutation = useGatewayMutation<{ workflow: string; input: Record<string, unknown> }>("launchRun");
      launch = mutation.mutate;
      runsReady = !runs.loading;
      snapshots.push((runs.data ?? []).map((row) => ({ synced: row.$synced })));
      return null;
    }

    const harness = await mountHarness();
    try {
      await harness.render(provider(registry, createElement(Probe)));
      await waitFor(() => runsReady && snapshots[snapshots.length - 1]?.length === 0);

      let pending!: Promise<unknown>;
      await act(async () => {
        pending = launch({ workflow: "deploy", input: {} });
        await settle();
      });
      await waitFor(() => snapshots.some((rows) => rows.some((row) => row.synced === false)));

      await act(async () => {
        rejectLaunch?.(new Error("launch failed"));
        await pending.catch(() => undefined);
      });
      await waitFor(() => snapshots[snapshots.length - 1]?.length === 0);
      expect(events.some((event) => event.type === "sync.mutation.rollback" && event.rollbackCount === 1)).toBe(true);
      expect(spans.some((span) => span.name === "smithers.sync.mutation.rollback")).toBe(true);
    } finally {
      restoreTelemetry();
      await harness.unmount();
    }
  });

  test("keeps the optimistic run visible across a delayed confirmation refetch (no flicker)", async () => {
    // The reviewer's repro: the launchRun RPC resolves, but the confirming
    // listRuns refetch is delayed. The optimistic transaction must NOT complete
    // (and the row must NOT blink out) until that confirmation lands, and
    // `mutate()` must stay pending the whole time so a button can't double-fire.
    let launchedRunId: string | undefined;
    let releaseConfirm: (() => void) | undefined;
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    let listCalls = 0;
    const registry = createGatewayCollections({
      client: makeTransport((method, params) => {
        if (method === "launchRun") {
          const options = (params as { options?: { runId?: string } }).options ?? {};
          launchedRunId = options.runId;
          return Promise.resolve({ runId: launchedRunId, workflow: "deploy" });
        }
        if (method === "listRuns") {
          listCalls += 1;
          // First call is the cold initial load; every confirmation read after
          // the launch is held until the gate is released.
          if (listCalls === 1) return Promise.resolve([]);
          return confirmGate.then(() =>
            launchedRunId
              ? [{ runId: launchedRunId, workflowKey: "deploy", status: "running", createdAtMs: 1 }]
              : [],
          );
        }
        return Promise.resolve({});
      }).transport,
    });

    const snapshots: Array<Array<{ runId: string; synced: boolean | undefined }>> = [];
    let runsReady = false;
    let launch: (vars: { workflow: string; input: Record<string, unknown> }) => Promise<{ runId?: string }> = async () => ({});
    function Probe() {
      const runs = useGatewayRuns();
      const mutation = useGatewayMutation<{ workflow: string; input: Record<string, unknown> }, { runId?: string }>(
        "launchRun",
      );
      launch = mutation.mutate;
      runsReady = !runs.loading;
      snapshots.push((runs.data ?? []).map((row) => ({ runId: row.runId, synced: row.$synced })));
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => runsReady && snapshots[snapshots.length - 1]?.length === 0);

    let resolved = false;
    let pending!: Promise<{ runId?: string }>;
    await act(async () => {
      pending = launch({ workflow: "deploy", input: {} }).then((value) => {
        resolved = true;
        return value;
      });
      await settle();
    });

    // RPC resolved and the optimistic row is visible, but confirmation is gated.
    await waitFor(() => snapshots.some((rows) => rows.some((row) => row.synced === false)));
    expect(typeof launchedRunId).toBe("string");
    await settle(6);
    // The mutation has NOT resolved (still confirming) and the row is still there.
    expect(resolved).toBe(false);
    const firstSeen = snapshots.findIndex((rows) => rows.some((row) => row.runId === launchedRunId));
    expect(firstSeen).toBeGreaterThanOrEqual(0);
    expect(snapshots.slice(firstSeen).every((rows) => rows.some((row) => row.runId === launchedRunId))).toBe(true);

    // Release the gated confirmation: the row stays put and flips to synced.
    await act(async () => {
      releaseConfirm?.();
      await pending;
    });
    expect(resolved).toBe(true);
    await waitFor(() =>
      snapshots.some((rows) => rows.some((row) => row.runId === launchedRunId && row.synced === true)),
    );
    // Continuous visibility across the entire lifecycle — once present, never absent.
    const seenAt = snapshots.findIndex((rows) => rows.some((row) => row.runId === launchedRunId));
    expect(snapshots.slice(seenAt).every((rows) => rows.some((row) => row.runId === launchedRunId))).toBe(true);
    expect(snapshots[snapshots.length - 1].find((row) => row.runId === launchedRunId)?.synced).toBe(true);
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

  test("useGatewayApprovals, useGatewayWorkflows, and useGatewayTickets surface their lists", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listApprovals") {
          return Promise.resolve([{ runId: "run-1", nodeId: "approve", iteration: 0, requestedAtMs: 1 }]);
        }
        if (method === "listDocs") {
          return Promise.resolve([{ path: "conflicts/demo.json", kind: "conflict", content: "{}", contentHash: "hash", updatedAtMs: 2, deletedAtMs: null }]);
        }
        if (method === "listWorkflows") return Promise.resolve([{ key: "deploy", hasUi: true, uiPath: "/x" }]);
        return Promise.resolve([]);
      }).transport,
    });

    let approvals: ReturnType<typeof useGatewayApprovals> | undefined;
    let tickets: ReturnType<typeof useGatewayTickets> | undefined;
    let workflows: ReturnType<typeof useGatewayWorkflows> | undefined;
    function Probe() {
      approvals = useGatewayApprovals({ filter: { runId: "run-1" } });
      tickets = useGatewayTickets();
      workflows = useGatewayWorkflows({ filter: { hasUi: true } });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => (approvals?.data?.length ?? 0) === 1 && (tickets?.data?.length ?? 0) === 1 && (workflows?.data?.length ?? 0) === 1);
    expect(approvals?.data?.[0]?.nodeId).toBe("approve");
    expect(tickets?.data?.[0]?.kind).toBe("conflict");
    expect(workflows?.data?.[0]?.key).toBe("deploy");

    await harness.unmount();
  });

  test("collection-backed hooks surface load errors", async () => {
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.reject(new Error("listRuns failed"));
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
    await waitFor(() => snapshot?.error?.message === "listRuns failed");
    expect(snapshot?.loading).toBe(false);
    await harness.unmount();
  });

  test("surface load errors through a createSource-selected source (the real app's path)", async () => {
    // apps/smithers does NOT pass a pre-built `source`; it passes `createSource`
    // so the registry injects its per-collection status hooks into the source it
    // builds at boot. This proves the error surfaces on THAT path — the previous
    // gap was an external pre-built source whose load failures were silently
    // reported as success.
    const registry = createGatewayCollections({
      createSource: (hooks) =>
        createGatewaySyncSource({
          transport: makeTransport((method) =>
            method === "listRuns"
              ? Promise.reject(new Error("listRuns failed via createSource"))
              : Promise.resolve([]),
          ).transport,
          ...hooks,
        }),
    });

    let snapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function Probe() {
      snapshot = useGatewayRuns();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => snapshot?.error?.message === "listRuns failed via createSource");
    expect(snapshot?.loading).toBe(false);
    await harness.unmount();
  });
});

describe("collection persistence", () => {
  test("rehydrates a collection from SQLite persistence before the first live load", async () => {
    const persistence = createMemoryPersistenceAdapter();
    const first = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([{ runId: "warm-run", status: "running" }]);
        return Promise.resolve([]);
      }).transport,
      persistence,
      schemaVersion: "0016",
    });

    let firstSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function FirstProbe() {
      firstSnapshot = useGatewayRuns();
      return null;
    }

    const firstHarness = await mountHarness();
    await firstHarness.render(provider(first, createElement(FirstProbe)));
    await waitFor(() => firstSnapshot?.data?.[0]?.runId === "warm-run");
    await waitFor(() => persistence.rows(syncKeyFingerprint(gatewayKeys.runs({}))).length === 1);
    await firstHarness.unmount();

    let resolveColdLoad: (rows: unknown[]) => void = () => {};
    const second = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return new Promise((resolve) => {
          resolveColdLoad = resolve;
        });
        return Promise.resolve([]);
      }).transport,
      persistence,
      schemaVersion: "0016",
    });

    let secondSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function SecondProbe() {
      secondSnapshot = useGatewayRuns();
      return null;
    }

    const secondHarness = await mountHarness();
    await secondHarness.render(provider(second, createElement(SecondProbe)));
    await waitFor(() => secondSnapshot?.data?.[0]?.runId === "warm-run");
    expect(secondSnapshot?.loading).toBe(false);

    await act(async () => {
      resolveColdLoad([{ runId: "live-run", status: "ok" }]);
    });
    await waitFor(() => secondSnapshot?.data?.[0]?.runId === "live-run");
    await secondHarness.unmount();
  });

  test("schemaVersion bump clears persisted rows and forces a cold resync", async () => {
    const persistence = createMemoryPersistenceAdapter();
    const seed = createGatewayCollections({
      client: makeTransport(() => Promise.resolve([{ runId: "old-run", status: "running" }])).transport,
      persistence,
      schemaVersion: "0016",
    });

    let seedSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function SeedProbe() {
      seedSnapshot = useGatewayRuns();
      return null;
    }

    const seedHarness = await mountHarness();
    await seedHarness.render(provider(seed, createElement(SeedProbe)));
    await waitFor(() => seedSnapshot?.data?.[0]?.runId === "old-run");
    await seedHarness.unmount();

    let calls = 0;
    const bumped = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") {
          calls += 1;
          return Promise.resolve([{ runId: "new-run", status: "queued" }]);
        }
        return Promise.resolve([]);
      }).transport,
      persistence,
      schemaVersion: "0017",
    });

    let bumpedSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function BumpedProbe() {
      bumpedSnapshot = useGatewayRuns();
      return null;
    }

    const bumpedHarness = await mountHarness();
    await bumpedHarness.render(provider(bumped, createElement(BumpedProbe)));
    expect(bumpedSnapshot?.data?.some((row) => row.runId === "old-run")).not.toBe(true);
    await waitFor(() => bumpedSnapshot?.data?.[0]?.runId === "new-run");
    expect(calls).toBeGreaterThanOrEqual(1);
    await bumpedHarness.unmount();
  });

  test("large node output and diff reads are not persisted collections", async () => {
    const savedIds: string[] = [];
    const registry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "getNodeOutput") return Promise.resolve({ status: "produced", output: "x".repeat(1024) });
        if (method === "getNodeDiff") return Promise.resolve({ summary: { filesChanged: 1 }, files: [] });
        if (method === "listRuns") return Promise.resolve([{ runId: "run-1", status: "ok" }]);
        return Promise.resolve([]);
      }).transport,
      persistence: {
        async loadRows() {
          return [];
        },
        async saveRows(request: { collectionId: string }) {
          savedIds.push(request.collectionId);
        },
      },
      schemaVersion: "0016",
    });

    let snapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function Probe() {
      snapshot = useGatewayRuns();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => snapshot?.data?.[0]?.runId === "run-1");
    await act(async () => {
      await registry.rpc("getNodeOutput", { runId: "run-1", nodeId: "n1" });
      await registry.rpc("getNodeDiff", { runId: "run-1", nodeId: "n1", iteration: 0 });
    });
    expect(savedIds.some((id) => id.includes("getNodeOutput") || id.includes("getNodeDiff"))).toBe(false);
    await harness.unmount();
  });

  test("rehydrates from a real bun:sqlite file before the first live frame (warm start)", async () => {
    const path = tmpSqlitePath();
    const runsId = syncKeyFingerprint(gatewayKeys.runs({}));

    // Session 1: cold-load from the gateway, persist to a real SQLite file.
    const writerAdapter = await createBunSqlitePersistenceAdapter({ path });
    const first = createGatewayCollections({
      client: makeTransport((method) =>
        method === "listRuns"
          ? Promise.resolve([{ runId: "warm-run", status: "running" }])
          : Promise.resolve([]),
      ).transport,
      persistence: writerAdapter,
      schemaVersion: "0016",
    });

    let firstSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function FirstProbe() {
      firstSnapshot = useGatewayRuns();
      return null;
    }
    const firstHarness = await mountHarness();
    await firstHarness.render(provider(first, createElement(FirstProbe)));
    await waitFor(() => firstSnapshot?.data?.[0]?.runId === "warm-run");
    await waitForAsync(async () => (await writerAdapter.loadRows(runsId, "0016")).length === 1);
    await firstHarness.unmount();
    writerAdapter.close?.();

    // Session 2 (the reload): a fresh adapter on the same file, and a gateway
    // whose live load never resolves — so the only way "warm-run" can appear is
    // a real SQLite rehydration that completes before any live frame.
    const readerAdapter = await createBunSqlitePersistenceAdapter({ path });
    const second = createGatewayCollections({
      client: makeTransport(() => new Promise<unknown[]>(() => {})).transport,
      persistence: readerAdapter,
      schemaVersion: "0016",
    });

    let secondSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function SecondProbe() {
      secondSnapshot = useGatewayRuns();
      return null;
    }
    const secondHarness = await mountHarness();
    await secondHarness.render(provider(second, createElement(SecondProbe)));
    await waitFor(() => secondSnapshot?.data?.[0]?.runId === "warm-run");
    expect(secondSnapshot?.loading).toBe(false);
    await secondHarness.unmount();
    readerAdapter.close?.();
  });

  test("schemaVersion bump clears a real bun:sqlite copy and forces a cold resync", async () => {
    const path = tmpSqlitePath();

    const seedAdapter = await createBunSqlitePersistenceAdapter({ path });
    const seed = createGatewayCollections({
      client: makeTransport(() => Promise.resolve([{ runId: "old-run", status: "running" }])).transport,
      persistence: seedAdapter,
      schemaVersion: "0016",
    });
    let seedSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function SeedProbe() {
      seedSnapshot = useGatewayRuns();
      return null;
    }
    const seedHarness = await mountHarness();
    await seedHarness.render(provider(seed, createElement(SeedProbe)));
    await waitFor(() => seedSnapshot?.data?.[0]?.runId === "old-run");
    await waitForAsync(async () =>
      (await seedAdapter.loadRows(syncKeyFingerprint(gatewayKeys.runs({})), "0016")).length === 1,
    );
    await seedHarness.unmount();
    seedAdapter.close?.();

    // Reopen at a bumped schemaVersion: the stale "old-run" copy is wiped and a
    // cold load runs.
    const bumpedAdapter = await createBunSqlitePersistenceAdapter({ path });
    const bumped = createGatewayCollections({
      client: makeTransport((method) =>
        method === "listRuns"
          ? Promise.resolve([{ runId: "new-run", status: "queued" }])
          : Promise.resolve([]),
      ).transport,
      persistence: bumpedAdapter,
      schemaVersion: "0017",
    });
    let bumpedSnapshot: ReturnType<typeof useGatewayRuns> | undefined;
    function BumpedProbe() {
      bumpedSnapshot = useGatewayRuns();
      return null;
    }
    const bumpedHarness = await mountHarness();
    await bumpedHarness.render(provider(bumped, createElement(BumpedProbe)));
    expect(bumpedSnapshot?.data?.some((row) => row.runId === "old-run")).not.toBe(true);
    await waitFor(() => bumpedSnapshot?.data?.[0]?.runId === "new-run");
    await bumpedHarness.unmount();
    bumpedAdapter.close?.();
  });

  test("large node-output payloads are stripped from persisted run events", async () => {
    const savedRows: Array<{ key: string; row: unknown }> = [];
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({
      client: stream.transport,
      persistence: {
        async loadRows() {
          return [];
        },
        async saveRows(request: { rows: readonly { key: string; row: unknown }[] }) {
          savedRows.push(...request.rows);
        },
      },
      schemaVersion: "0016",
    });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("blob-run", { maxEvents: 16 });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    const huge = "x".repeat(200_000);
    await act(async () => {
      stream.push("streamRunEvents", "blob-run", {
        key: gatewayKeys.runEvents("blob-run"),
        seq: 1,
        event: "node.output",
        payload: { output: huge },
      });
    });

    // The live ring keeps the full payload for the UI...
    await waitFor(() => (snapshot?.events.at(-1)?.payload as { output?: string } | undefined)?.output === huge);
    // ...but the durable copy carries only the truncation marker — the blob is
    // never written to client persistence (design §5.4).
    await waitFor(() => savedRows.length > 0);
    const persistedSeq1 = savedRows.find((r) => (r.row as { seq?: number }).seq === 1);
    expect(persistedSeq1).toBeDefined();
    expect((persistedSeq1!.row as { payload?: unknown }).payload).toMatchObject({ $truncated: true });
    expect(JSON.stringify(savedRows).includes(huge)).toBe(false);
    await harness.unmount();
  });
});

describe("source parity", () => {
  test("the same run-list hook works over gateway and fake Electric SyncSources", async () => {
    const gatewayRegistry = createGatewayCollections({
      client: makeTransport((method) => {
        if (method === "listRuns") return Promise.resolve([{ runId: "gateway-run", status: "running" }]);
        return Promise.resolve([]);
      }).transport,
    });
    const electricSource = createFakeElectricSyncSource();
    electricSource.setRows(gatewayCollectionDefs.runs({}), [{ runId: "electric-run", status: "queued" }]);
    const electricRegistry = createGatewayCollections({ source: electricSource });

    const seen: string[] = [];
    function Probe() {
      const runs = useGatewayRuns();
      const id = runs.data?.[0]?.runId;
      if (id) seen.push(id);
      return null;
    }

    const gatewayHarness = await mountHarness();
    await gatewayHarness.render(provider(gatewayRegistry, createElement(Probe)));
    await waitFor(() => seen.includes("gateway-run"));
    await gatewayHarness.unmount();

    const electricHarness = await mountHarness();
    await electricHarness.render(provider(electricRegistry, createElement(Probe)));
    await waitFor(() => seen.includes("electric-run"));
    await electricHarness.unmount();
  });

  test("useGatewayRun renders the same over gateway and fake Electric", async () => {
    const gateway = createGatewayCollections({
      client: makeTransport((method) =>
        method === "getRun" ? Promise.resolve({ runId: "run-1", status: "running" }) : Promise.resolve({}),
      ).transport,
    });
    const electric = createFakeElectricSyncSource();
    electric.setRows(gatewayCollectionDefs.run("run-1"), [{ runId: "run-1", status: "running" }]);
    const electricRegistry = createGatewayCollections({ source: electric });

    const ok = (r: ReturnType<typeof useGatewayRun>) => (r.data as { status?: string } | undefined)?.status === "running";
    await assertOverSource(gateway, () => useGatewayRun("run-1"), ok);
    await assertOverSource(electricRegistry, () => useGatewayRun("run-1"), ok);
  });

  test("useGatewayApprovals renders the same over gateway and fake Electric", async () => {
    const approval = { runId: "run-1", nodeId: "approve", iteration: 0, requestedAtMs: 1 };
    const gateway = createGatewayCollections({
      client: makeTransport((method) =>
        method === "listApprovals" ? Promise.resolve([approval]) : Promise.resolve([]),
      ).transport,
    });
    const electric = createFakeElectricSyncSource();
    electric.setRows(gatewayCollectionDefs.approvals({}), [approval]);
    const electricRegistry = createGatewayCollections({ source: electric });

    const ok = (a: ReturnType<typeof useGatewayApprovals>) => a.data?.[0]?.nodeId === "approve";
    await assertOverSource(gateway, () => useGatewayApprovals(), ok);
    await assertOverSource(electricRegistry, () => useGatewayApprovals(), ok);
  });

  test("useGatewayWorkflows renders the same over gateway and fake Electric", async () => {
    const workflow = { key: "deploy", hasUi: true, uiPath: "/x" };
    const gateway = createGatewayCollections({
      client: makeTransport((method) =>
        method === "listWorkflows" ? Promise.resolve([workflow]) : Promise.resolve([]),
      ).transport,
    });
    const electric = createFakeElectricSyncSource();
    electric.setRows(gatewayCollectionDefs.workflows({}), [workflow]);
    const electricRegistry = createGatewayCollections({ source: electric });

    const ok = (w: ReturnType<typeof useGatewayWorkflows>) => w.data?.[0]?.key === "deploy";
    await assertOverSource(gateway, () => useGatewayWorkflows(), ok);
    await assertOverSource(electricRegistry, () => useGatewayWorkflows(), ok);
  });

  test("useGatewayRunTree projects a tree the same over gateway and fake Electric", async () => {
    const gateway = createGatewayCollections({
      client: makeTransport((method) =>
        method === "getDevToolsSnapshot"
          ? Promise.resolve({
              root: {
                id: 0,
                name: "Workflow",
                type: "Workflow",
                children: [{ id: 1, name: "a", type: "Task", task: { nodeId: "a" } }],
              },
              runState: { state: "running" },
            })
          : Promise.resolve({}),
      ).transport,
    });
    const electric = createFakeElectricSyncSource();
    electric.setRows(gatewayCollectionDefs.nodes("run-1"), [
      { id: "0", name: "Workflow", kind: "Workflow", status: "running", childIds: ["a"] },
      { id: "a", name: "a", kind: "Task", status: "ok", parentId: "0" },
    ]);
    const electricRegistry = createGatewayCollections({ source: electric });

    const ok = (t: ReturnType<typeof useGatewayRunTree>) => t.root !== null && t.nodes.length > 0;
    await assertOverSource(gateway, () => useGatewayRunTree("run-1"), ok);
    await assertOverSource(electricRegistry, () => useGatewayRunTree("run-1"), ok);
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

  test("large bursts keep the persisted run event ring bounded", async () => {
    let maxPersistedRows = 0;
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({
      client: stream.transport,
      persistence: {
        async loadRows() {
          return [];
        },
        async saveRows(request: { rows: readonly unknown[] }) {
          maxPersistedRows = Math.max(maxPersistedRows, request.rows.length);
        },
      },
      schemaVersion: "0016",
    });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("burst-run", { maxEvents: 1024 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      for (let seq = 1; seq <= 1_500; seq += 1) {
        stream.push("streamRunEvents", "burst-run", {
          key: gatewayKeys.runEvents("burst-run"),
          seq,
          event: "run.event",
          payload: { seq },
        });
      }
    });
    await waitFor(() => snapshot?.events.at(-1)?.seq === 1_500);
    await waitFor(() => maxPersistedRows > 0);
    expect(maxPersistedRows).toBeLessThanOrEqual(1_024);
    expect(snapshot?.events.length).toBeLessThanOrEqual(1_024);
    await harness.unmount();
  });

  test("a slow persistence consumer never blocks the producer and stays bounded", async () => {
    let saveCalls = 0;
    let maxRowsSeen = 0;
    const gates: Array<() => void> = [];
    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({
      client: stream.transport,
      persistence: {
        async loadRows() {
          return [];
        },
        async saveRows(request: { rows: readonly unknown[] }) {
          saveCalls += 1;
          maxRowsSeen = Math.max(maxRowsSeen, request.rows.length);
          // Hold the save open: the producer must drain regardless of how slow
          // the persistence consumer is.
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
        },
      },
      schemaVersion: "0016",
    });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("slow-run", { maxEvents: 1024 });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    await waitFor(() => stream.opens.length === 1);

    await act(async () => {
      for (let seq = 1; seq <= 1_500; seq += 1) {
        stream.push("streamRunEvents", "slow-run", {
          key: gatewayKeys.runEvents("slow-run"),
          seq,
          event: "run.event",
          payload: { seq },
        });
      }
    });

    // All 1500 frames landed in the live ring while the very first persist save
    // is still held open — the slow consumer did not stall the stream. Writes
    // are coalesced, so the consumer was invoked far fewer times than frames.
    await waitFor(() => snapshot?.events.at(-1)?.seq === 1_500);
    await waitFor(() => saveCalls >= 1);
    expect(saveCalls).toBeLessThan(50);
    expect(snapshot?.events.length).toBeLessThanOrEqual(1_024);

    // Drain the held saves; every persisted snapshot stayed within the ring.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        for (const release of gates.splice(0)) release();
      });
      await settle(2);
    }
    expect(maxRowsSeen).toBeLessThanOrEqual(1_024);
    await harness.unmount();
  });

  test("resumes the stream from the persisted high-water seq after reload (no missed offline frames)", async () => {
    const persistence = createMemoryPersistenceAdapter();
    const runEventsId = syncKeyFingerprint(gatewayKeys.runEvents("resume-run"));
    // A prior session cached run events up to seq 42.
    await persistence.saveRows({
      collectionId: runEventsId,
      schemaVersion: "0016",
      rows: [
        { key: "n:40", row: { key: gatewayKeys.runEvents("resume-run"), seq: 40, event: "run.event", payload: { seq: 40 } } },
        { key: "n:42", row: { key: gatewayKeys.runEvents("resume-run"), seq: 42, event: "run.event", payload: { seq: 42 } } },
      ],
    });

    const stream = makeTransport(() => Promise.reject(new Error("not used")));
    const registry = createGatewayCollections({
      client: stream.transport,
      persistence,
      schemaVersion: "0016",
    });

    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;
    function Probe() {
      snapshot = useGatewayRunEvents("resume-run", { maxEvents: 1024 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(provider(registry, createElement(Probe)));
    // Warm hydrate from the persisted ring…
    await waitFor(() => snapshot?.events.some((event) => event.seq === 42) === true);
    // …then the live stream opens RESUMING after the cached max seq, so frames
    // produced while the client was offline are replayed instead of dropped.
    await waitFor(() =>
      stream.opens.some((open) => open.scope === "streamRunEvents" && open.afterSeq === 42),
    );
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
