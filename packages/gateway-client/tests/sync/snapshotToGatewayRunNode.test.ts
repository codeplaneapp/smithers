import { describe, expect, test } from "bun:test";
import { snapshotToGatewayRunNode } from "../../src/sync/snapshotToGatewayRunNode.ts";

/**
 * A realistic `getDevToolsSnapshot` payload, matching what the server's
 * `getDevToolsSnapshot` route actually emits: a `{ root }` tree (not an array)
 * whose structural tag lands on `type` as a LOWERCASE `DevToolsNodeType`
 * (`"workflow"`, `"sequence"`, `"task"`, `"approval"`), NOT a capitalized
 * component name. Container nodes carry no `task` identity; logical task nodes
 * carry `task.nodeId` and a semantic `task.kind`. The blocked node is the one a
 * paused run waits on.
 */
const snapshot = {
  root: {
    id: 1,
    name: "Workflow",
    type: "workflow",
    children: [
      {
        id: 2,
        name: "sequence",
        type: "sequence",
        children: [
          {
            id: 3,
            name: "PlanTask",
            type: "task",
            task: { nodeId: "plan", kind: "agent", label: "Plan the work", iteration: 0 },
            children: [],
          },
          {
            id: 4,
            name: "Gate",
            type: "approval",
            task: { nodeId: "approve", kind: "static" },
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
    // Root: a structural `workflow` node keyed on its numeric id, mirroring the run.
    expect(tree).toMatchObject({
      id: "1",
      name: "Workflow",
      kind: "workflow",
      status: "waiting",
    });
    const sequence = tree?.children?.[0];
    // Containers roll up from their children: the gate below is waiting, so
    // the sequence reads waiting rather than a meaningless neutral queued.
    expect(sequence).toMatchObject({ id: "2", kind: "compute", status: "waiting" });
    const [plan, gate] = sequence?.children ?? [];
    // Logical task nodes key on task.nodeId and prefer task.label for the name.
    expect(plan).toMatchObject({ id: "plan", name: "Plan the work", kind: "agent", status: "queued" });
    // The blocked node is the one the paused run waits on.
    expect(gate).toMatchObject({ id: "approve", name: "approve", kind: "approval", status: "waiting" });
  });

  test("renders task.state as the node status when the snapshot carries it", () => {
    // A live run whose snapshot carries per-node lifecycle (attached by the
    // server from node rows, #817): finished renders ok, in-progress renders
    // running, failed renders failed — while a stateless sibling stays queued
    // and the blocked node still wins as waiting.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "workflow",
        children: [
          { id: 2, name: "A", type: "task", task: { nodeId: "a", kind: "compute", state: "finished", attempt: 1 }, children: [] },
          { id: 3, name: "B", type: "task", task: { nodeId: "b", kind: "agent", state: "in-progress", attempt: 2 }, children: [] },
          { id: 4, name: "C", type: "task", task: { nodeId: "c", kind: "agent", state: "failed", attempt: 3 }, children: [] },
          { id: 5, name: "D", type: "task", task: { nodeId: "d", kind: "agent" }, children: [] },
          { id: 6, name: "E", type: "approval", task: { nodeId: "e", kind: "static", state: "in-progress" }, children: [] },
        ],
      },
      runState: { state: "running", blocked: { nodeId: "e" } },
    });
    const [a, b, c, d, e] = tree?.children ?? [];
    expect(a).toMatchObject({ id: "a", status: "ok" });
    expect(b).toMatchObject({ id: "b", status: "running" });
    expect(c).toMatchObject({ id: "c", status: "failed" });
    expect(d).toMatchObject({ id: "d", status: "queued" });
    // blockedNodeId still outranks the raw state for the gate the run waits on.
    expect(e).toMatchObject({ id: "e", status: "waiting" });
  });

  test("containers roll their status up from their children", () => {
    const container = (id: number, name: string, children: unknown[]) =>
      ({ id, name, type: "sequence", children }) as never;
    const task = (id: number, nodeId: string, state?: string) =>
      ({ id, name: nodeId, type: "task", task: { nodeId, kind: "agent", ...(state ? { state } : {}) }, children: [] }) as never;
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "workflow",
        children: [
          container(10, "busy", [task(11, "a", "finished"), task(12, "b", "in-progress")]),
          container(20, "done", [task(21, "c", "finished"), task(22, "d", "finished")]),
          container(30, "broken", [task(31, "e", "finished"), task(32, "f", "failed")]),
          container(40, "mixed", [task(41, "g", "finished"), task(42, "h")]),
        ],
      },
      runState: { state: "running" },
    });
    const [busy, done, broken, mixed] = tree?.children ?? [];
    expect(busy).toMatchObject({ status: "running" });
    expect(done).toMatchObject({ status: "ok" });
    expect(broken).toMatchObject({ status: "failed" });
    // A stateless child means work may still be coming: stay neutral.
    expect(mixed).toMatchObject({ status: "queued" });
  });

  test("a terminal run never renders stranded in-progress nodes as running", () => {
    // Cancelling (or crashing) a run can leave node rows frozen at
    // in-progress; the tree must not claim anything is running on a dead run.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "workflow",
        children: [
          { id: 2, name: "A", type: "task", task: { nodeId: "a", kind: "agent", state: "in-progress" }, children: [] },
          { id: 3, name: "B", type: "task", task: { nodeId: "b", kind: "compute", state: "finished" }, children: [] },
        ],
      },
      runState: { state: "cancelled" },
    });
    const [a, b] = tree?.children ?? [];
    expect(a).toMatchObject({ id: "a", status: "cancelled" });
    expect(b).toMatchObject({ id: "b", status: "ok" });
  });

  test("a finished run still renders stateless and unknown-state nodes ok", () => {
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "workflow",
        children: [
          { id: 2, name: "A", type: "task", task: { nodeId: "a", kind: "compute", state: "finished" }, children: [] },
          { id: 3, name: "B", type: "task", task: { nodeId: "b", kind: "agent", state: "someday-new-state" }, children: [] },
          { id: 4, name: "C", type: "task", task: { nodeId: "c", kind: "agent" }, children: [] },
        ],
      },
      runState: { state: "finished" },
    });
    const [a, b, c] = tree?.children ?? [];
    expect(a).toMatchObject({ status: "ok" });
    expect(b).toMatchObject({ status: "ok" });
    expect(c).toMatchObject({ status: "ok" });
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
        type: "loop",
        children: [
          { id: 3, name: "Plan", type: "task", task: { nodeId: "plan", kind: "agent", iteration: 0 }, children: [] },
          { id: 4, name: "Plan", type: "task", task: { nodeId: "plan", kind: "agent", iteration: 1 }, children: [] },
        ],
      },
    });
    const [a, b] = tree?.children ?? [];
    expect(a).toMatchObject({ key: "3", id: "plan", iteration: 0 });
    expect(b).toMatchObject({ key: "4", id: "plan", iteration: 1 });
  });

  test("maps a durable HumanTask (task tagged __smithersKind: human) to the human kind", () => {
    // The gateway renders `<HumanTask>` as a `task` element whose serialized
    // props carry `__smithersKind: "human"`; newer snapshots also carry
    // `task.kind: "human"`. Mapping either to "human" is what lets the monitor
    // surface CLI guidance instead of approve/deny controls that would strand
    // the run on a durable input gate.
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "workflow",
        type: "workflow",
        children: [
          {
            id: 2,
            name: "human:review",
            type: "task",
            props: { __smithersKind: "human", label: "human:review" },
            task: { nodeId: "review", kind: "static", label: "human:review" },
            children: [],
          },
        ],
      },
      runState: { state: "waiting-approval", blocked: { nodeId: "review" } },
    });
    const human = tree?.children?.[0];
    expect(human).toMatchObject({ id: "review", kind: "human", status: "waiting" });
  });

  test("maps declared and acting agent metadata onto node.agent", () => {
    const tree = snapshotToGatewayRunNode({
      root: {
        id: 1,
        name: "Workflow",
        type: "workflow",
        children: [
          {
            // QUEUED node with only the declared assignment (+ failover chain).
            id: 2,
            name: "Review",
            type: "task",
            task: {
              nodeId: "review",
              kind: "agent",
              agentSummary: {
                label: "Reviewer",
                engine: "claude-code",
                model: "claude-fable-5",
                chain: [
                  { engine: "claude-code", model: "claude-fable-5" },
                  { engine: "codex", model: "gpt-5.4-codex" },
                ],
              },
              maxAttempts: 3,
            },
            children: [],
          },
          {
            // Settled node on an old run: only attempt metadata exists.
            id: 3,
            name: "Exec",
            type: "task",
            task: {
              nodeId: "exec",
              kind: "agent",
              state: "finished",
              attempt: 2,
              agentRan: { agentId: "primary", engine: "codex", model: "gpt-5.4-codex" },
            },
            children: [],
          },
          {
            // Legacy plain-string agent prop still passes through untouched.
            id: 4,
            name: "Legacy",
            type: "task",
            task: { nodeId: "legacy", kind: "agent", agent: "old-string-agent" },
            children: [],
          },
        ],
      },
      runState: { state: "running" },
    });
    const [review, exec, legacy] = tree?.children ?? [];
    expect(review?.agent).toEqual({
      name: "Reviewer",
      engine: "claude-code",
      model: "claude-fable-5",
      chain: [
        { engine: "claude-code", model: "claude-fable-5" },
        { engine: "codex", model: "gpt-5.4-codex" },
      ],
    });
    expect(review?.maxAttempts).toBe(3);
    // No declared summary: the acting agent still yields a structured record,
    // with `name` falling back to the engine so tree chips keep rendering.
    expect(exec?.agent).toEqual({
      name: "codex",
      ranOn: { agentId: "primary", engine: "codex", model: "gpt-5.4-codex" },
    });
    expect(exec?.attempt).toBe(2);
    expect(exec?.maxAttempts).toBeUndefined();
    expect(legacy?.agent).toBe("old-string-agent");
  });

  test("returns null for the gateway empty-root placeholder", () => {
    expect(snapshotToGatewayRunNode({ root: { id: 0, name: "(empty)", children: [] } })).toBeNull();
    expect(snapshotToGatewayRunNode(null)).toBeNull();
    expect(snapshotToGatewayRunNode({})).toBeNull();
  });

  test("marks every node ok once the run has finished", () => {
    const done = snapshotToGatewayRunNode({
      root: { id: 1, name: "Workflow", type: "workflow", children: [{ id: 2, name: "Task", type: "task", task: { nodeId: "a", kind: "agent" }, children: [] }] },
      runState: { state: "succeeded" },
    });
    expect(done?.status).toBe("ok");
    expect(done?.children?.[0]?.status).toBe("ok");
  });

  test("maps every real lowercase node type onto the graph palette (default compute)", () => {
    // The cases mirror the LOWERCASE `DevToolsNodeType` values the server emits.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "approval" }, "approval"],
      [{ type: "wait-for-event" }, "signal"],
      [{ type: "timer" }, "signal"],
      // A durable human gate is a `task` tagged __smithersKind: "human".
      [{ type: "task", props: { __smithersKind: "human" } }, "human"],
      // Newer gateway snapshots preserve the same semantic on task.kind too.
      [{ type: "task", task: { nodeId: "n", kind: "human" } }, "human"],
      // Approval gates are still structural task nodes, but task.kind carries the gate semantic.
      [{ type: "task", task: { nodeId: "n", kind: "approval" } }, "approval"],
      [{ type: "loop" }, "loop"],
      [{ type: "parallel" }, "parallel"],
      [{ type: "saga" }, "saga"],
      [{ type: "try-catch" }, "try-catch"],
      [{ type: "workflow" }, "workflow"],
      // Agent vs compute tasks are distinguished by the task descriptor's kind.
      [{ type: "task", task: { nodeId: "n", kind: "agent" } }, "agent"],
      [{ type: "task", task: { nodeId: "n", kind: "compute" } }, "compute"],
      [{ type: "task", props: { __smithersKind: "compute" } }, "compute"],
      // A task with no semantic kind defaults to the agent tone.
      [{ type: "task", task: { nodeId: "n", kind: "static" } }, "agent"],
      [{ type: "unknown" }, "compute"],
      [{}, "compute"],
    ];
    for (const [overrides, kind] of cases) {
      const tree = snapshotToGatewayRunNode({
        root: { id: 1, name: "n", task: { nodeId: "n" }, children: [], ...overrides },
      });
      expect(tree?.kind, `${JSON.stringify(overrides)} -> ${kind}`).toBe(kind);
    }
  });

  test("nodeName falls back label -> props.label -> props.name -> task.nodeId -> node.name", () => {
    // task.label wins over everything.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "task", task: { nodeId: "n", label: "L" }, props: { label: "P", name: "Q" }, children: [] } })?.name).toBe("L");
    // No task.label -> props.label.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "task", task: { nodeId: "n" }, props: { label: "P", name: "Q" }, children: [] } })?.name).toBe("P");
    // No labels -> props.name.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "task", task: { nodeId: "n" }, props: { name: "Q" }, children: [] } })?.name).toBe("Q");
    // No props labels -> task.nodeId.
    expect(snapshotToGatewayRunNode({ root: { id: 1, name: "struct", type: "task", task: { nodeId: "n" }, children: [] } })?.name).toBe("n");
    // No task at all -> structural node.name.
    expect(snapshotToGatewayRunNode({ root: { id: 7, name: "struct", type: "sequence", children: [] } })?.name).toBe("struct");
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
        root: { id: 1, name: "Workflow", type: "workflow", task: { nodeId: "r" }, children: [] },
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
        type: "workflow",
        children: [{ id: 2, name: "Task", type: "task", task: { nodeId: "a", kind: "agent" }, children: [] }],
      },
      runState: { state: "cancelled" },
    });
    expect(tree?.status).toBe("cancelled");
    expect(tree?.children?.[0]?.status).toBe("queued");
  });
});
