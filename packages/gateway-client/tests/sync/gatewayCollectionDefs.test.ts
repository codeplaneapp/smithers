import { createCollection } from "@tanstack/db";
import { describe, expect, test } from "bun:test";
import { createGatewayCollection } from "../../src/sync/createGatewayCollection.ts";
import {
  eventRows,
  gatewayCollectionDefs,
  runRowsFromFrame,
  runStatusFromFrame,
} from "../../src/sync/gatewayCollectionDefs.ts";
import type { GatewayRunNode } from "../../src/sync/GatewayRunNode.ts";
import type { GatewayRunRow } from "../../src/sync/GatewayRunRow.ts";
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

describe("gatewayCollectionDefs", () => {
  test("defines workflow, run list, run, approvals, and run event collections", () => {
    const workflows = gatewayCollectionDefs.workflows({ filter: { hasUi: true } });
    expect(workflows).toMatchObject({
      key: ["gateway:listWorkflows", { hasUi: true }],
      method: "listWorkflows",
      params: { filter: { hasUi: true } },
    });
    expect(workflows.getKey({ key: "wf", name: "Workflow" } as never)).toBe("wf");
    expect(workflows.rows([{ key: "wf" }])).toEqual([{ key: "wf" }]);
    expect(workflows.rows({ key: "wf" })).toEqual([]);

    const runs = gatewayCollectionDefs.runs({ workflowKey: "wf" });
    expect(runs).toMatchObject({
      key: ["gateway:listRuns", { workflowKey: "wf" }],
      method: "listRuns",
      params: { workflowKey: "wf" },
    });
    expect(runs.getKey({ runId: "run-1" })).toBe("run-1");
    expect(runs.rows([{ runId: "run-1" }])).toEqual([{ runId: "run-1" }]);

    const run = gatewayCollectionDefs.run("run-1");
    expect(run).toMatchObject({
      key: ["gateway:getRun", { runId: "run-1" }],
      method: "getRun",
      params: { runId: "run-1" },
      stream: { scope: "streamRunEvents", params: { runId: "run-1" } },
    });
    expect(run.getKey({ runId: "run-1" })).toBe("run-1");
    expect(run.rows({ runId: "run-1", status: "running" })).toEqual([{ runId: "run-1", status: "running" }]);
    expect(run.rows([{ runId: "run-1" }])).toEqual([]);

    const approvals = gatewayCollectionDefs.approvals({ runId: "run-1" });
    expect(approvals).toMatchObject({
      key: ["gateway:listApprovals", { runId: "run-1" }],
      method: "listApprovals",
      params: { runId: "run-1" },
    });
    expect(approvals.getKey({ runId: "run-1", nodeId: "approve", iteration: 2 } as never)).toBe("run-1:approve:2");
    expect(approvals.rows([{ runId: "run-1", nodeId: "approve", iteration: 2 }])).toEqual([
      { runId: "run-1", nodeId: "approve", iteration: 2 },
    ]);

    const runEvents = gatewayCollectionDefs.runEvents("run-1", 2);
    expect(runEvents).toMatchObject({
      key: ["gateway:streamRunEvents", { runId: "run-1" }],
      stream: { scope: "streamRunEvents", params: { runId: "run-1" }, maxRows: 2 },
    });
    expect(runEvents.getKey({ key: ["gateway:streamRunEvents", { runId: "run-1" }], seq: 12, event: "event", payload: {} })).toBe(12);
  });
});

describe("gateway run stream frame mappers", () => {
  test("maps run event frames only when a sequence is present", () => {
    const keyedFrame = {
      key: ["gateway:streamRunEvents", { runId: "run-1" }],
      seq: 11,
      event: "gateway.event",
      payload: { event: "run.started", payload: { runId: "run-1" } },
    } as const;

    expect(eventRows(keyedFrame)).toEqual([
      {
        key: ["gateway:streamRunEvents", { runId: "run-1" }],
        seq: 11,
        event: "gateway.event",
        payload: { event: "run.started", payload: { runId: "run-1" } },
      },
    ]);
    expect(eventRows({ ...keyedFrame, seq: undefined })).toEqual([]);
  });

  test("maps gateway run lifecycle events to run statuses", () => {
    expect(runStatusFromFrame({ payload: { event: "run.started", payload: {} } })).toBe("running");
    expect(runStatusFromFrame({ payload: { event: "run.resumed", payload: {} } })).toBe("running");
    expect(runStatusFromFrame({ payload: { event: "run.paused", payload: {} } })).toBe("waiting");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "ok" } } })).toBe("ok");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { status: "succeeded" } } })).toBe("succeeded");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "failed" } } })).toBe("failed");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: { state: "cancelled" } } })).toBe("failed");
    expect(runStatusFromFrame({ payload: { event: "run.completed", payload: {} } })).toBe("ok");
    expect(runStatusFromFrame({ payload: { event: "node.started", payload: {} } })).toBeUndefined();
    expect(runStatusFromFrame({ payload: null })).toBeUndefined();
  });

  test("updates the current run row and omits virtual fields", () => {
    const current: GatewayRunRow = {
      runId: "run-1",
      status: "waiting",
      workflowKey: "wf",
      $optimistic: true,
      summary: undefined,
    };
    const mapper = runRowsFromFrame("run-1");
    const collection = {
      get(key: string) {
        return key === "run-1" ? current : undefined;
      },
    };

    expect(mapper(
      { payload: { event: "run.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([{ runId: "run-1", status: "running", workflowKey: "wf" }]);
    expect(mapper(
      { payload: { event: "node.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([]);
    expect(runRowsFromFrame("missing")(
      { payload: { event: "run.started", payload: {} } },
      { collection: collection as never },
    )).toEqual([]);
  });
});
