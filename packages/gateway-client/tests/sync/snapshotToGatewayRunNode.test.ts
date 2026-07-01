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

  test("gives each node a unique structural key while exposing the logical id", () => {
    // A loop whose body renders the same logical task (`plan`) at two distinct
    // structural positions (ids 3 and 4), differing only by iteration. The
    // structural id becomes the unique `key`; the logical `task.nodeId` stays on
    // `id` for the RPCs. Without distinct keys these two attempts would collapse.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Loop",
        type: "Loop",
        children: [
          { id: 3, name: "Plan", type: "Task", task: { nodeId: "plan", iteration: 0 }, children: [] },
          { id: 4, name: "Plan", type: "Task", task: { nodeId: "plan", iteration: 1 }, children: [] },
        ],
      },
    });
    const [a, b] = tree?.children ?? [];
    expect(a).toMatchObject({ key: "3", id: "plan", iteration: 0 });
    expect(b).toMatchObject({ key: "4", id: "plan", iteration: 1 });
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

  test("maps every structural tag onto the graph palette (default compute)", () => {
    const cases: Array<[string | undefined, string]> = [
      ["Approval", "approval"],
      ["Signal", "signal"],
      ["WaitForEvent", "signal"],
      ["Human", "human"],
      ["HumanTask", "human"],
      ["Loop", "loop"],
      ["ForEach", "loop"],
      ["Task", "agent"],
      ["Agent", "agent"],
      ["SomethingElse", "compute"],
      [undefined, "compute"],
    ];
    for (const [type, kind] of cases) {
      const tree = snapshotToGatewayRunNode({
        root: { id: 1, name: "n", type, task: { nodeId: "n" }, children: [] },
      });
      expect(tree?.kind, `type ${String(type)} -> ${kind}`).toBe(kind);
    }
  });

  test("nodeName falls back label -> props.label -> props.name -> task.nodeId -> node.name", () => {
    // task.label wins over everything.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "Task", task: { nodeId: "n", label: "L" }, props: { label: "P", name: "Q" }, children: [] } })?.name).toBe("L");
    // No task.label -> props.label.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "Task", task: { nodeId: "n" }, props: { label: "P", name: "Q" }, children: [] } })?.name).toBe("P");
    // No labels -> props.name.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "Task", task: { nodeId: "n" }, props: { name: "Q" }, children: [] } })?.name).toBe("Q");
    // No props labels -> task.nodeId.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "Task", task: { nodeId: "n" }, children: [] } })?.name).toBe("n");
    // No task at all -> structural node.name.
    expect(snapshotToGatewayRunNode({ root: { id: 7, name: "struct", type: "Sequence", children: [] } })?.name).toBe("struct");
  });

  test("toRunStatus collapses lifecycle states onto the UI tones at the root", () => {
    const cases: Array<[string | undefined, string]> = [
      ["running", "running"],
      ["finished", "ok"],
      ["completed", "ok"],
      ["ok", "ok"],
      ["failed", "failed"],
      ["errored", "failed"],
      // Cancelled is preserved as its OWN tone (not collapsed to failed) so a
      // deliberate cancel renders dim/grey rather than as a red error.
      ["cancelled", "cancelled"],
      ["canceled", "cancelled"],
      ["waiting-event", "waiting"],
      ["waiting-timer", "waiting"],
      ["waiting", "waiting"],
      ["blocked", "waiting"],
      ["mystery", "queued"],
      [undefined, "queued"],
    ];
    for (const [state, status] of cases) {
      const tree = snapshotToGatewayRunNode({
        root: { id: 1, name: "Workflow", type: "Workflow", task: { nodeId: "r" }, children: [] },
        runState: state === undefined ? {} : { state },
      });
      expect(tree?.status, `state ${String(state)} -> ${status}`).toBe(status);
    }
  });

  test("carries cancelled through the node status model instead of a red failure", () => {
    // A cancelled run: the root mirrors the run's `cancelled` tone (so the tree
    // and graph render it dim/grey, not the red failure ✗). Non-root nodes stay
    // neutral `queued` (the snapshot carries no per-node lifecycle), exactly as a
    // failed run leaves them — cancelled is never coerced to `failed`.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "Workflow",
        children: [{ id: 2, name: "Task", type: "Task", task: { nodeId: "a" }, children: [] }],
      },
      runState: { state: "cancelled" },
    });
    expect(tree?.status).toBe("cancelled");
    expect(tree?.children?.[0]?.status).toBe("queued");
  });
});
