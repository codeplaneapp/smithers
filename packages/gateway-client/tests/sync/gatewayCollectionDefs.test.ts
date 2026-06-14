import { createCollection } from "@tanstack/db";
import { describe, expect, test } from "bun:test";
import { createGatewayCollection } from "../../src/sync/createGatewayCollection.ts";
import { gatewayCollectionDefs } from "../../src/sync/gatewayCollectionDefs.ts";
import type { GatewayRunNode } from "../../src/sync/GatewayRunNode.ts";
import type { SyncStreamFrame, SyncTransport } from "../../src/sync/SyncTransport.ts";

/** A real `getDevToolsSnapshot` payload: a `{ root }` tree, not an array. */
const snapshot = {
  root: {
    id: 1,
    name: "Workflow",
    type: "Workflow",
    children: [
      {
        id: 2,
        name: "Sequence",
        type: "Sequence",
        children: [
          { id: 3, name: "PlanTask", type: "Task", task: { nodeId: "plan", label: "Plan" }, children: [] },
          { id: 4, name: "Gate", type: "Approval", task: { nodeId: "approve" }, children: [] },
        ],
      },
    ],
  },
  runState: { state: "waiting-approval", blocked: { nodeId: "approve" } },
};

/**
 * A transport whose RPC returns `payload` and whose DevTools stream opens but
 * stays quiet until aborted — enough to exercise the initial load without
 * spinning the reconnect loop.
 */
function quietTransport(payload: unknown): SyncTransport {
  return {
    rpc() {
      return Promise.resolve(payload);
    },
    stream(_scope: string, _params: unknown, options: { signal?: AbortSignal }): AsyncIterable<SyncStreamFrame> {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) return resolve();
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      };
    },
  };
}

describe("gatewayCollectionDefs.nodes", () => {
  test("rows mapper flattens a real { root } snapshot into node rows", () => {
    const rows = Array.from(gatewayCollectionDefs.nodes("run-1").rows(snapshot));
    expect(rows.map((row) => row.id)).toEqual(["1", "2", "plan", "approve"]);
    expect(rows.find((row) => row.id === "1")?.childIds).toEqual(["2"]);
    expect(rows.find((row) => row.id === "2")?.childIds).toEqual(["plan", "approve"]);
    expect(rows.find((row) => row.id === "plan")).toMatchObject({ kind: "agent", parentId: "2", childIds: [] });
    expect(rows.find((row) => row.id === "approve")).toMatchObject({ kind: "approval", status: "waiting" });
  });

  test("honors a caller-supplied rows mapper", () => {
    const custom = (): GatewayRunNode[] => [{ id: "x", name: "X", kind: "compute", status: "ok" }];
    expect(gatewayCollectionDefs.nodes("run-1", custom).rows).toBe(custom);
  });

  test("populates a TanStack DB collection from the snapshot RPC", async () => {
    const collection = createCollection<GatewayRunNode, string>(
      createGatewayCollection({ ...gatewayCollectionDefs.nodes("run-1"), client: quietTransport(snapshot) }),
    );

    await collection.preload();

    expect(Array.from(collection.keys()).sort()).toEqual(["1", "2", "approve", "plan"]);
    expect(collection.get("approve")?.status).toBe("waiting");
    expect(collection.get("plan")?.parentId).toBe("2");
  });

  test("stays empty for the gateway empty-root placeholder", async () => {
    const collection = createCollection<GatewayRunNode, string>(
      createGatewayCollection({
        ...gatewayCollectionDefs.nodes("run-1"),
        client: quietTransport({ root: { id: 0, name: "(empty)", children: [] } }),
      }),
    );

    await collection.preload();

    expect(collection.size).toBe(0);
    expect(collection.status).toBe("ready");
  });
});
