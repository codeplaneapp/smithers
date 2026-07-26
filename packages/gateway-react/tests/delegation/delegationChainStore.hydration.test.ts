import { describe, expect, test } from "bun:test";
import {
  createDelegationChainStore,
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
  children: [{ logicalId: "root/c1", tier: "sonnet", kind: "leaf", title: "c1", brief: "Build c1", estimate: est }],
  subtreeEstimate: est,
  risks: [],
};

const execC1: DcExecRow = { logicalId: "root/c1", attempt: 1, summary: "built c1", artifacts: [] };

function inputs(overrides: Partial<DelegationChainInputs> = {}): DelegationChainInputs {
  return { treeNodes: [], treeLoading: false, events: [], approvals: [], ...overrides };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

describe("createDelegationChainStore hydration", () => {
  test("does not hydrate until distinct target fetch fibers have all settled", async () => {
    const planGate = deferred();
    const execGate = deferred();
    let planFetches = 0;
    let execFetches = 0;
    const gatedApi: DelegationChainApi = {
      listRunEvents: async () => [],
      getNodeOutput: async ({ runId, nodeId }) => {
        if (runId !== RUN_ID) throw new Error(`unexpected run ${runId}`);
        if (nodeId === "dc:root:plan") {
          planFetches += 1;
          await planGate.promise;
          return { status: "produced", row: planRow };
        }
        if (nodeId === "dc:root:c1:exec") {
          execFetches += 1;
          await execGate.promise;
          return { status: "produced", row: execC1 };
        }
        throw new Error(`unexpected node ${nodeId}`);
      },
    };
    const { store, updates, unsubscribe } = trackedStore(gatedApi);
    try {
      store.push(inputs({ treeNodes: [{ id: "dc:root:plan", iteration: 0 }] }));
      await waitFor(() => planFetches === 1);

      store.push(
        inputs({
          treeNodes: [
            { id: "dc:root:plan", iteration: 0 },
            { id: "dc:root:c1:exec", iteration: 0 },
          ],
        }),
      );
      await waitFor(() => execFetches === 1);

      execGate.resolve();
      await settle(updates);
      expect(store.getSnapshot().targetCount).toBe(2);
      expect(store.getSnapshot().hydrated).toBe(false);

      planGate.resolve();
      await waitFor(() => store.getSnapshot().hydrated);
      expect(store.getSnapshot().graph.rootId).toBe("root");
    } finally {
      unsubscribe();
      store.dispose();
    }
  });
});
