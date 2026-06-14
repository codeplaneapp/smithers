import { describe, expect, test } from "bun:test";
import { snapshotToGatewayRunNode } from "../../src/sync/snapshotToGatewayRunNode.ts";

/**
 * A realistic `getDevToolsSnapshot` payload: a `{ root }` tree (not an array),
 * mixing structural container nodes (no `task` identity) with logical task nodes
 * that carry `task.nodeId`. The blocked node is the one a paused run waits on.
 */
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
          {
            id: 3,
            name: "PlanTask",
            type: "Task",
            task: { nodeId: "plan", label: "Plan the work", iteration: 0 },
            children: [],
          },
          {
            id: 4,
            name: "Gate",
            type: "Approval",
            task: { nodeId: "approve" },
            children: [],
          },
        ],
      },
    ],
  },
  runState: { state: "waiting-approval", blocked: { nodeId: "approve" } },
};

describe("snapshotToGatewayRunNode", () => {
  test("maps a real snapshot tree into a GatewayRunNode tree", () => {
    const tree = snapshotToGatewayRunNode(snapshot);
    // Root: a structural Workflow node keyed on its numeric id, mirroring the run.
    expect(tree).toMatchObject({
      id: "1",
      name: "Workflow",
      kind: "compute",
      status: "waiting",
    });
    const sequence = tree?.children?.[0];
    expect(sequence).toMatchObject({ id: "2", kind: "compute", status: "queued" });
    const [plan, gate] = sequence?.children ?? [];
    // Logical task nodes key on task.nodeId and prefer task.label for the name.
    expect(plan).toMatchObject({ id: "plan", name: "Plan the work", kind: "agent", status: "queued" });
    // The blocked node is the one the paused run waits on.
    expect(gate).toMatchObject({ id: "approve", name: "approve", kind: "approval", status: "waiting" });
  });

  test("returns null for the gateway empty-root placeholder", () => {
    expect(snapshotToGatewayRunNode({ root: { id: 0, name: "(empty)", children: [] } })).toBeNull();
    expect(snapshotToGatewayRunNode(null)).toBeNull();
    expect(snapshotToGatewayRunNode({})).toBeNull();
  });

  test("marks every node ok once the run has finished", () => {
    const done = snapshotToGatewayRunNode({
      root: { id: 1, name: "Workflow", type: "Workflow", children: [{ id: 2, name: "Task", type: "Task", task: { nodeId: "a" }, children: [] }] },
      runState: { state: "succeeded" },
    });
    expect(done?.status).toBe("ok");
    expect(done?.children?.[0]?.status).toBe("ok");
  });
});
