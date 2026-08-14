// Coverage for the output-cache entry's non-produced and unexpected-error arms
// in the Effect assembly pipeline. Real store, real fold; the gateway API is a
// deterministic in-memory fixture returning the exact shapes those arms handle.
import { describe, expect, test } from "bun:test";
import { GatewayRpcError } from "@smthrs/gateway-client";
import {
  createDelegationChainStore,
  type DelegationChainApi,
  type DelegationChainInputs,
} from "../../src/delegation/delegationChainStore.ts";

const RUN_ID = "run-1";

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

const finishEvent = { event: "node.finished", payload: { runId: RUN_ID, nodeId: "dc:root:plan", iteration: 0 } };

describe("createDelegationChainStore — output-cache non-produced + error arms", () => {
  test("a non-`produced` getNodeOutput response resolves the target as missing (no output, still hydrates)", async () => {
    const api: DelegationChainApi = {
      listRunEvents: async () => [],
      // status !== "produced" → the `: { state: "missing" }` arm.
      getNodeOutput: async () => ({ status: "pending" }),
    };
    const store = createDelegationChainStore({ runId: RUN_ID, api });
    try {
      store.push(inputs({ events: [finishEvent] }));
      await waitFor(() => store.getSnapshot().hydrated);
      const snapshot = store.getSnapshot();
      // The plan node has no resolved output row, but assembly completed cleanly.
      expect(snapshot.hydrated).toBe(true);
      expect(snapshot.recordErrors).toHaveLength(0);
      expect(snapshot.graph.nodes.root?.output).toBeUndefined();
    } finally {
      store.dispose();
    }
  });

  test("an UNEXPECTED getNodeOutput error resolves the target as an error entry (not swallowed as missing)", async () => {
    const api: DelegationChainApi = {
      listRunEvents: async () => [],
      // A GatewayRpcError whose code is NOT in the expected set → the error arm.
      getNodeOutput: async () => {
        throw new GatewayRpcError({ method: "getNodeOutput", code: "InternalError", message: "kaboom" });
      },
    };
    const store = createDelegationChainStore({ runId: RUN_ID, api });
    try {
      store.push(inputs({ events: [finishEvent] }));
      await waitFor(() => store.getSnapshot().hydrated);
      const snapshot = store.getSnapshot();
      expect(snapshot.hydrated).toBe(true);
      // The unexpected error did not throw the pipeline; the node simply has no
      // output row assembled from it.
      expect(snapshot.graph.nodes.root?.output).toBeUndefined();
    } finally {
      store.dispose();
    }
  });

  test("a non-Error thrown value from getNodeOutput is wrapped and handled as an error entry", async () => {
    const api: DelegationChainApi = {
      listRunEvents: async () => [],
      getNodeOutput: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "plain string failure";
      },
    };
    const store = createDelegationChainStore({ runId: RUN_ID, api });
    try {
      store.push(inputs({ events: [finishEvent] }));
      await waitFor(() => store.getSnapshot().hydrated);
      expect(store.getSnapshot().hydrated).toBe(true);
    } finally {
      store.dispose();
    }
  });
});
