// Unit coverage for the Effect record-assembly pipeline behind
// useDelegationChain (Queue-fed Stream reconciling into a SubscriptionRef).
// The gateway API is a deterministic in-memory fixture seeded with real row
// payloads — the store under test, the fold, and the target enumeration are
// all the real implementations.
import { describe, expect, test } from "bun:test";
import { GatewayRpcError } from "@smithers-orchestrator/gateway-client";
import {
  createDelegationChainStore,
  EVENT_HISTORY_PAGE_SIZE,
  MAX_OUTPUT_FETCH_ATTEMPTS,
  type DelegationChainApi,
  type DelegationChainInputs,
  type DelegationChainStore,
} from "../../src/delegation/delegationChainStore.ts";
import type { DcExecRow, DcPlanRow } from "../../src/delegation/types.ts";

const RUN_ID = "run-1";

const est = { tokens: 1000, costUsd: 0.5, minutes: 5 };

const planRow: DcPlanRow = {
  logicalId: "root",
  tier: "fable",
  title: "root",
  brief: "Plan for root",
  children: [
    { logicalId: "root/c1", tier: "sonnet", kind: "leaf", title: "c1", brief: "Build c1", estimate: est },
    { logicalId: "root/c2", tier: "sonnet", kind: "leaf", title: "c2", brief: "Build c2", estimate: est },
  ],
  subtreeEstimate: { tokens: 3000, costUsd: 1.5, minutes: 15 },
  risks: [],
};

const execC1: DcExecRow = { logicalId: "root/c1", attempt: 1, summary: "built c1", artifacts: [] };
const execC2: DcExecRow = { logicalId: "root/c2", attempt: 1, summary: "built c2", artifacts: [] };

type HistoryRow = { seq: number; event: string; payload?: unknown };

function finished(seq: number, nodeId: string, iteration = 0): HistoryRow {
  return { seq, event: "NodeFinished", payload: { runId: RUN_ID, nodeId, iteration } };
}

/** Deterministic in-memory gateway API fixture (append-only history + output rows). */
function makeApiFixture(options: { history: HistoryRow[]; outputs: Map<string, unknown> }) {
  const calls = { listRunEvents: 0, getNodeOutput: new Map<string, number>() };
  const api: DelegationChainApi = {
    listRunEvents: async ({ runId, limit, afterSeq }) => {
      calls.listRunEvents += 1;
      if (runId !== RUN_ID) return [];
      return options.history
        .filter((row) => afterSeq === undefined || row.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },
    getNodeOutput: async ({ runId, nodeId, iteration }) => {
      const key = `${nodeId}\x00${iteration}`;
      calls.getNodeOutput.set(key, (calls.getNodeOutput.get(key) ?? 0) + 1);
      const row = runId === RUN_ID ? options.outputs.get(key) : undefined;
      if (row === undefined) {
        throw new GatewayRpcError({ method: "getNodeOutput", code: "NodeHasNoOutput", message: "no output row" });
      }
      return { status: "produced", row };
    },
  };
  return { api, calls, outputs: options.outputs };
}

function inputs(overrides: Partial<DelegationChainInputs> = {}): DelegationChainInputs {
  return { treeNodes: [], treeLoading: false, events: [], approvals: [], ...overrides };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait until the store publishes nothing new for a couple of poll windows. */
async function settle(getUpdateCount: () => number): Promise<void> {
  let last = getUpdateCount();
  let stableTicks = 0;
  const start = Date.now();
  while (stableTicks < 3) {
    if (Date.now() - start > 5000) throw new Error("settle: store never went quiet");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const now = getUpdateCount();
    stableTicks = now === last ? stableTicks + 1 : 0;
    last = now;
  }
}

function trackedStore(api: DelegationChainApi): {
  store: DelegationChainStore;
  updates: () => number;
  unsubscribe: () => void;
} {
  const store = createDelegationChainStore({ runId: RUN_ID, api });
  let updates = 0;
  const unsubscribe = store.subscribe(() => {
    updates += 1;
  });
  return { store, updates: () => updates, unsubscribe };
}

describe("createDelegationChainStore — record assembly", () => {
  test("assembles the graph from the durable history backfill, fetching each (nodeId, iteration) exactly once", async () => {
    const fixture = makeApiFixture({
      history: [
        finished(1, "dc:root:plan"),
        finished(2, "dc:root:c1:exec"),
        finished(3, "dc:root:c1:exec", 1),
        finished(4, "not-a-delegation-node"),
      ],
      outputs: new Map<string, unknown>([
        ["dc:root:plan\x000", planRow],
        ["dc:root:c1:exec\x000", execC1],
        ["dc:root:c1:exec\x001", { ...execC1, attempt: 2, summary: "rebuilt c1" }],
      ]),
    });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      store.push(inputs());
      await waitFor(() => store.getSnapshot().hydrated && store.getSnapshot().graph.rootId === "root");
      await settle(updates);
      const snapshot = store.getSnapshot();
      // The tree pushed NOTHING — every target came from the durable event
      // history (loop iterations the current frame no longer shows).
      expect(snapshot.targetCount).toBe(3);
      expect(snapshot.graph.nodes["root/c1"]!.status).toBe("done");
      expect((snapshot.graph.nodes["root/c1"]!.output as DcExecRow).summary).toBe("rebuilt c1");
      expect(snapshot.recordErrors).toHaveLength(0);
      expect(snapshot.historyError).toBeUndefined();
      // Exactly-once fetch per (nodeId, iteration), across every reconcile.
      for (const [key, count] of fixture.calls.getNodeOutput) {
        expect({ key, count }).toEqual({ key, count: 1 });
      }
      expect(fixture.calls.getNodeOutput.size).toBe(3);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("emits exactly one snapshot update per pushed batch (and none for a no-op batch)", async () => {
    const fixture = makeApiFixture({ history: [], outputs: new Map() });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      store.push(inputs());
      await settle(updates);
      const baseline = updates();

      // One batch delivering one pending approval: exactly ONE update, even
      // though it changes the graph, the fold issues, and node attention.
      const approvals = [{ runId: RUN_ID, nodeId: "dc:root:c1:approval-1", iteration: 0 }];
      const batch = inputs({ approvals });
      store.push(batch);
      await waitFor(() => store.getSnapshot().graph.nodes["root/c1"]?.status === "awaiting-human");
      await settle(updates);
      expect(updates()).toBe(baseline + 1);

      // Re-pushing the identical batch publishes nothing.
      store.push(batch);
      await settle(updates);
      expect(updates()).toBe(baseline + 1);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("a batch of new live events publishes twice at most: target discovery, then the settled fetch batch", async () => {
    const fixture = makeApiFixture({
      history: [],
      outputs: new Map<string, unknown>([
        ["dc:root:plan\x000", planRow],
        ["dc:root:c1:exec\x000", execC1],
        ["dc:root:c2:exec\x000", execC2],
      ]),
    });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      store.push(inputs());
      await settle(updates);
      const baseline = updates();

      // One batch, three new targets: one update for the discovered targets,
      // one when the parallel getNodeOutput batch settles — never one per row.
      store.push(
        inputs({
          events: [
            { event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:plan", iteration: 0 } },
            { event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:c1:exec", iteration: 0 } },
            { event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:c2:exec", iteration: 0 } },
          ],
        }),
      );
      await waitFor(() => store.getSnapshot().graph.rootId === "root" && store.getSnapshot().hydrated);
      await settle(updates);
      expect(updates()).toBe(baseline + 2);
      expect(store.getSnapshot().graph.nodes["root/c2"]!.status).toBe("done");
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("missing outputs are refetched only on a NEW finish event (event-driven invalidation)", async () => {
    const key = "dc:root:c1:exec\x000";
    const fixture = makeApiFixture({
      history: [finished(1, "dc:root:c1:exec")],
      outputs: new Map(),
    });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      const firstFinish = inputs({
        events: [{ event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:c1:exec", iteration: 0 } }],
      });
      store.push(firstFinish);
      await waitFor(() => store.getSnapshot().hydrated);
      await settle(updates);
      const callsAfterFirst = fixture.calls.getNodeOutput.get(key) ?? 0;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      // Re-pushing without a new finish event never refetches the missing row.
      store.push(inputs({ events: [...firstFinish.events] }));
      await settle(updates);
      expect(fixture.calls.getNodeOutput.get(key)).toBe(callsAfterFirst);

      // The row lands durably, a second finish tick arrives → one refetch.
      fixture.outputs.set(key, execC1);
      store.push(
        inputs({
          events: [
            ...firstFinish.events,
            { event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:c1:exec", iteration: 0 } },
          ],
        }),
      );
      await waitFor(() => store.getSnapshot().graph.nodes["root/c1"]?.status === "done");
      expect(fixture.calls.getNodeOutput.get(key)).toBe(callsAfterFirst + 1);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("a finish that arrives after the event ring evicted the previous one still refetches", async () => {
    // The live buffer is a bounded ring (`useGatewayRunEvents` caps it at
    // RING_SIZE frames). Counting finish ticks off that window alone makes the
    // marker DROP BACK when the first finish is evicted, so the next finish
    // recomputes to the count the cache entry already recorded and the newly
    // produced row is never fetched. Ticks must accumulate instead.
    const RING_SIZE = 1000;
    const key = "dc:root:c1:exec\x000";
    const fixture = makeApiFixture({ history: [], outputs: new Map() });
    const frames: Array<{ seq: number; event: string; payload?: unknown }> = [
      { seq: 1, event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:c1:exec", iteration: 0 } },
    ];
    const ring = () => frames.slice(Math.max(0, frames.length - RING_SIZE));
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      store.push(inputs({ events: ring() }));
      await waitFor(() => store.getSnapshot().hydrated);
      await settle(updates);
      const callsAfterFirst = fixture.calls.getNodeOutput.get(key) ?? 0;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

      // Enough unrelated frames to push the first finish out of the ring.
      for (let seq = 2; seq <= RING_SIZE + 200; seq += 1) {
        frames.push({ seq, event: "node.started", payload: { runId: RUN_ID, nodeId: "not-a-delegation-node" } });
      }
      const evicted = ring();
      expect(evicted).toHaveLength(RING_SIZE);
      expect(evicted.some((frame) => frame.event === "node.finished")).toBe(false);
      store.push(inputs({ events: evicted }));
      await settle(updates);
      expect(fixture.calls.getNodeOutput.get(key)).toBe(callsAfterFirst);

      // The row lands durably and the node finishes again. Only ONE finish for
      // it is in the window now — the same windowed count as the first batch.
      fixture.outputs.set(key, execC1);
      frames.push({
        seq: frames.length + 1,
        event: "node.finished",
        payload: { runId: RUN_ID, nodeId: "dc:root:c1:exec", iteration: 0 },
      });
      store.push(inputs({ events: ring() }));
      await waitFor(() => store.getSnapshot().graph.nodes["root/c1"]?.status === "done", 2000);
      expect((store.getSnapshot().graph.nodes["root/c1"]!.output as DcExecRow).summary).toBe("built c1");
      expect(fixture.calls.getNodeOutput.get(key)).toBe(callsAfterFirst + 1);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("a transient getNodeOutput failure is retried until it succeeds, without another finish event", async () => {
    // The node finished exactly once and the first fetch died on the wire.
    // Before the fix the error entry captured that finish count and was only
    // ever re-fetched on a NEW finish event — which never comes for a node
    // that is already done, stranding the row forever.
    let fetches = 0;
    const flakyApi: DelegationChainApi = {
      listRunEvents: async () => [],
      getNodeOutput: async () => {
        fetches += 1;
        if (fetches === 1) throw new Error("socket hang up");
        return { status: "produced", row: planRow };
      },
    };
    const { store, updates, unsubscribe } = trackedStore(flakyApi);
    try {
      // A single batch, pushed once: no further input and no second finish.
      store.push(
        inputs({ events: [{ event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:plan", iteration: 0 } }] }),
      );
      await waitFor(() => store.getSnapshot().hydrated);
      await settle(updates);
      const snapshot = store.getSnapshot();
      expect(fetches).toBe(2);
      expect((snapshot.graph.nodes.root!.output as DcPlanRow).brief).toBe("Plan for root");
      expect(snapshot.recordErrors).toHaveLength(0);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("a permanently failing getNodeOutput stops after the bounded retries and still hydrates", async () => {
    let fetches = 0;
    const brokenApi: DelegationChainApi = {
      listRunEvents: async () => [],
      getNodeOutput: async () => {
        fetches += 1;
        throw new GatewayRpcError({ method: "getNodeOutput", code: "InternalError", message: "kaboom" });
      },
    };
    const { store, updates, unsubscribe } = trackedStore(brokenApi);
    try {
      store.push(
        inputs({ events: [{ event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:plan", iteration: 0 } }] }),
      );
      await waitFor(() => store.getSnapshot().hydrated);
      await settle(updates);
      // The retry budget is spent, then the entry goes quiet (no hot reconcile
      // loop) and the failure surfaces as a record error.
      expect(fetches).toBe(MAX_OUTPUT_FETCH_ATTEMPTS);
      expect(store.getSnapshot().recordErrors).toHaveLength(1);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("pages the full event history past the ring bound (afterSeq cursor)", async () => {
    const history: HistoryRow[] = [];
    for (let seq = 1; seq <= EVENT_HISTORY_PAGE_SIZE; seq += 1) {
      history.push(finished(seq, "dc:root:c1:exec", 0));
    }
    // The 501st event lives on the second page.
    history.push(finished(EVENT_HISTORY_PAGE_SIZE + 1, "dc:root:c1:exec", 7));
    const fixture = makeApiFixture({
      history,
      outputs: new Map<string, unknown>([
        ["dc:root:c1:exec\x000", execC1],
        ["dc:root:c1:exec\x007", { ...execC1, attempt: 8, summary: "late attempt" }],
      ]),
    });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    try {
      store.push(inputs());
      await waitFor(() => store.getSnapshot().hydrated && store.getSnapshot().targetCount === 2);
      await settle(updates);
      expect(fixture.calls.listRunEvents).toBe(2);
      expect((store.getSnapshot().graph.nodes["root/c1"]!.output as DcExecRow).summary).toBe("late attempt");
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("a failing backfill surfaces as historyError while tree-derived targets still assemble", async () => {
    const fixture = makeApiFixture({
      history: [],
      outputs: new Map<string, unknown>([["dc:root:plan\x000", planRow]]),
    });
    const failingApi: DelegationChainApi = {
      listRunEvents: async () => {
        throw new Error("event history unavailable");
      },
      getNodeOutput: fixture.api.getNodeOutput.bind(fixture.api),
    };
    const store = createDelegationChainStore({ runId: RUN_ID, api: failingApi });
    try {
      store.push(inputs({ treeNodes: [{ id: "dc:root:plan", iteration: 0 }] }));
      await waitFor(() => store.getSnapshot().hydrated && store.getSnapshot().historyError !== undefined);
      const snapshot = store.getSnapshot();
      expect(snapshot.historyError?.message).toBe("event history unavailable");
      expect(snapshot.graph.rootId).toBe("root");
    } finally {
      store.dispose();
    }
  });

  test("without a runId the store never fetches and never hydrates", async () => {
    const fixture = makeApiFixture({
      history: [finished(1, "dc:root:plan")],
      outputs: new Map<string, unknown>([["dc:root:plan\x000", planRow]]),
    });
    const store = createDelegationChainStore({ runId: undefined, api: fixture.api });
    try {
      store.push(inputs({ treeNodes: [{ id: "dc:root:plan", iteration: 0 }] }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fixture.calls.listRunEvents).toBe(0);
      expect(fixture.calls.getNodeOutput.size).toBe(0);
      const snapshot = store.getSnapshot();
      expect(snapshot.hydrated).toBe(false);
      // Targets are still enumerated (the hook renders loading from them).
      expect(snapshot.targetCount).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test("a second input batch during an in-flight fetch does not prematurely hydrate", async () => {
    // getNodeOutput blocks on a test-controlled gate so the forked fetch stays
    // pending across a second reconcile. The second batch's `due` is empty (the
    // sole target is in-flight, hence excluded), but hydration must NOT flip
    // while a fetch is outstanding — only OutputsSettled may hydrate it.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let fetchStarted = 0;
    const gatedApi: DelegationChainApi = {
      listRunEvents: async () => [],
      getNodeOutput: async ({ runId, nodeId }) => {
        fetchStarted += 1;
        await gate;
        if (runId !== RUN_ID || nodeId !== "dc:root:plan") {
          throw new GatewayRpcError({ method: "getNodeOutput", code: "NodeHasNoOutput", message: "no output row" });
        }
        return { status: "produced", row: planRow };
      },
    };
    const { store, updates, unsubscribe } = trackedStore(gatedApi);
    try {
      // Batch 1: one tree target discovered; the fetch forks and stays pending.
      store.push(inputs({ treeNodes: [{ id: "dc:root:plan", iteration: 0 }] }));
      await waitFor(() => fetchStarted === 1);
      // Batch 2 (fresh approvals array identity) lands while the fetch is still
      // in flight. Before the fix this flipped hydrated=true with zero outputs.
      store.push(inputs({ treeNodes: [{ id: "dc:root:plan", iteration: 0 }], approvals: [] }));
      await settle(updates);
      expect(store.getSnapshot().hydrated).toBe(false);
      // Releasing the gate settles the fetch and hydrates via OutputsSettled.
      releaseGate();
      await waitFor(() => store.getSnapshot().hydrated === true);
    } finally {
      unsubscribe();
      store.dispose();
    }
  });

  test("dispose interrupts the pipeline and is idempotent", async () => {
    const fixture = makeApiFixture({ history: [], outputs: new Map() });
    const { store, updates, unsubscribe } = trackedStore(fixture.api);
    store.push(inputs());
    await settle(updates);
    unsubscribe();
    expect(store.disposed).toBe(false);
    store.dispose();
    store.dispose();
    expect(store.disposed).toBe(true);
    const after = updates();
    store.push(inputs({ approvals: [{ runId: RUN_ID, nodeId: "dc:root:c1:approval-1", iteration: 0 }] }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updates()).toBe(after);
  });
});
