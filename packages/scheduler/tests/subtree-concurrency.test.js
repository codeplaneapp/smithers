import { describe, expect, test } from "bun:test";
import { scheduleTasks } from "../src/scheduleTasks.js";
import { buildStateKey } from "../src/buildStateKey.js";

/**
 * @param {string} nodeId
 * @param {object} [overrides]
 */
function makeDescriptor(nodeId, overrides = {}) {
  return {
    nodeId,
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    ...overrides,
  };
}

/** @param {Array<ReturnType<typeof makeDescriptor>>} descs */
function descriptorMap(...descs) {
  const map = new Map();
  for (const d of descs) map.set(d.nodeId, d);
  return map;
}

/**
 * Kanban-shaped fixture: a subtree-capped parallel of three two-task child
 * sequences (A, B, C). Every task records the subtree group; the plan mirrors
 * the document structure.
 * @param {number} subtreeMax
 * @param {object} [taskOverrides]
 */
function ticketFixture(subtreeMax, taskOverrides = {}) {
  const plan = {
    kind: "parallel",
    children: ["a", "b", "c"].map((child) => ({
      kind: "sequence",
      children: [
        { kind: "task", nodeId: `${child}1` },
        { kind: "task", nodeId: `${child}2` },
      ],
    })),
  };
  const descs = descriptorMap(
    ...["a", "b", "c"].flatMap((child) =>
      ["1", "2"].map((step) =>
        makeDescriptor(`${child}${step}`, {
          subtreeGroupId: "tickets",
          subtreeChildKey: child.toUpperCase(),
          subtreeMax,
          ...taskOverrides,
        }),
      ),
    ),
  );
  return { plan, descs };
}

describe("scheduleTasks subtree concurrency cap", () => {
  test("admits at most subtreeMax child subtrees, in declared order", () => {
    const { plan, descs } = ticketFixture(2);
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    // Sequences admit their first task each; child C waits for a slot.
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a1", "b1"]);
    expect(result.pendingExists).toBe(true);
  });

  test("subtreeMax=1 activates only the first child", () => {
    const { plan, descs } = ticketFixture(1);
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a1"]);
  });

  test("a restored approval keeps its subtree slot ahead of new pending siblings", () => {
    const { plan, descs } = ticketFixture(1);
    const approvedTaskKeys = new Set([buildStateKey("b1", 0)]);
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0, undefined, approvedTaskKeys);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b1"]);
  });

  test("an active child runs its remaining tasks freely while inactive children wait", () => {
    const { plan, descs } = ticketFixture(1);
    // A has started (a1 finished) and is not fully terminal: it stays active.
    const states = new Map([[buildStateKey("a1", 0), "finished"]]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a2"]);
  });

  test("a fully terminal child frees its slot for the next child (fill-as-you-go)", () => {
    const { plan, descs } = ticketFixture(2);
    const states = new Map([
      [buildStateKey("a1", 0), "finished"],
      [buildStateKey("a2", 0), "finished"],
      [buildStateKey("b1", 0), "in-progress"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // A is done (slot freed), B is active; C now activates.
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["c1"]);
  });

  test("over-cap in-flight children (e.g. after a cap decrease on resume) all finish", () => {
    const { plan, descs } = ticketFixture(1);
    const states = new Map([
      [buildStateKey("a1", 0), "finished"],
      [buildStateKey("b1", 0), "finished"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // Both A and B are already in flight: each may finish; C stays blocked.
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a2", "b2"]);
  });

  test("a waiting task marks its child as in flight (activation is not double-spent)", () => {
    const { plan, descs } = ticketFixture(1);
    const states = new Map([[buildStateKey("a1", 0), "waiting-approval"]]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // A holds the only slot while paused at the gate; B and C wait.
    expect(result.runnable).toEqual([]);
    expect(result.waitingApprovalExists).toBe(true);
  });

  test("composes with a nested leaf-group cap: both must pass", () => {
    // Two children, each an inner parallel of two tasks capped at 1 leaf.
    const plan = {
      kind: "parallel",
      children: ["a", "b"].map((child) => ({
        kind: "parallel",
        children: [
          { kind: "task", nodeId: `${child}1` },
          { kind: "task", nodeId: `${child}2` },
        ],
      })),
    };
    const descs = descriptorMap(
      ...["a", "b"].flatMap((child) =>
        ["1", "2"].map((step) =>
          makeDescriptor(`${child}${step}`, {
            parallelGroupId: `inner-${child}`,
            parallelMaxConcurrency: 1,
            subtreeGroupId: "tickets",
            subtreeChildKey: child.toUpperCase(),
            subtreeMax: 2,
          }),
        ),
      ),
    );
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    // Subtree cap admits both children; each inner leaf cap admits one task.
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a1", "b1"]);
  });

  test("a task from an active child still respects its leaf-group cap", () => {
    const plan = {
      kind: "parallel",
      children: [
        {
          kind: "parallel",
          children: [
            { kind: "task", nodeId: "a1" },
            { kind: "task", nodeId: "a2" },
          ],
        },
        { kind: "task", nodeId: "b1" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a1", {
        parallelGroupId: "inner-a",
        parallelMaxConcurrency: 1,
        subtreeGroupId: "tickets",
        subtreeChildKey: "A",
        subtreeMax: 1,
      }),
      makeDescriptor("a2", {
        parallelGroupId: "inner-a",
        parallelMaxConcurrency: 1,
        subtreeGroupId: "tickets",
        subtreeChildKey: "A",
        subtreeMax: 1,
      }),
      makeDescriptor("b1", {
        subtreeGroupId: "tickets",
        subtreeChildKey: "B",
        subtreeMax: 1,
      }),
    );
    const states = new Map([[buildStateKey("a1", 0), "in-progress"]]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // a2's child is active but the inner leaf cap is saturated by a1;
    // b1 is blocked by the subtree cap. A leaf-cap rejection must not leak
    // a subtree activation for B either.
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(true);
  });

  test("failed leaf without continueOnFail keeps its child active (no premature slot release)", () => {
    const { plan, descs } = ticketFixture(1);
    const states = new Map([[buildStateKey("a1", 0), "failed"]]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // A started and is not fully terminal; siblings do not steal the slot
    // while retry/recovery decides A's fate.
    expect(result.runnable).toEqual([]);
  });

  test("failed leaf WITH continueOnFail is terminal for slot accounting", () => {
    const { plan, descs } = ticketFixture(1, { continueOnFail: true });
    const states = new Map([
      [buildStateKey("a1", 0), "failed"],
      [buildStateKey("a2", 0), "failed"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b1"]);
  });

  test("resume determinism: identical admission from a restored state map, regardless of plan order", () => {
    const restoredStates = () =>
      new Map([
        [buildStateKey("b1", 0), "in-progress"],
        [buildStateKey("c1", 0), "finished"],
      ]);
    const run = () => {
      const { plan, descs } = ticketFixture(2);
      return scheduleTasks(plan, restoredStates(), descs, new Map(), new Map(), 0);
    };
    const first = run();
    const second = run();
    // B and C were in flight before the restart, so they keep their slots and
    // A (earlier in plan order) must NOT activate over them.
    expect(first.runnable.map((r) => r.nodeId)).toEqual(["c2"]);
    expect(second.runnable.map((r) => r.nodeId)).toEqual(first.runnable.map((r) => r.nodeId));
  });

  test("descriptors without subtree fields are unaffected", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "x" },
        { kind: "task", nodeId: "y" },
      ],
    };
    const descs = descriptorMap(makeDescriptor("x"), makeDescriptor("y"));
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["x", "y"]);
  });
});
