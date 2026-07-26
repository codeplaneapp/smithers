import { describe, expect, test } from "bun:test";
import { scheduleTasks } from "../src/scheduleTasks.js";

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

describe("no-double-dispatch invariant", () => {
  test("a capless in-progress task is neither runnable nor pending", () => {
    // This is what makes engine decide() report Wait instead of re-dispatching
    // (or busy-waiting on) a task that is already executing.
    const plan = { kind: "task", nodeId: "busy" };
    const result = scheduleTasks(
      plan,
      new Map([["busy::0", "in-progress"]]),
      descriptorMap(makeDescriptor("busy")),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
    expect(result.fatalError).toBeUndefined();
  });

  test("an unrecognized state string behaves like in-progress, not pending", () => {
    const plan = { kind: "task", nodeId: "odd" };
    const result = scheduleTasks(
      plan,
      new Map([["odd::0", "totally-unknown-state"]]),
      descriptorMap(makeDescriptor("odd")),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
  });
});

describe("cyclic dependsOn", () => {
  test("mutually dependent tasks block each other: nothing runnable, pending persists", () => {
    // There is no cycle detection in scheduleTasks — a dependsOn cycle
    // deadlocks quietly (both tasks stay pending forever). Pin the current
    // semantics so any future cycle detection is a deliberate change.
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(makeDescriptor("a", { dependsOn: ["b"] }), makeDescriptor("b", { dependsOn: ["a"] }));
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(true);
    expect(result.fatalError).toBeUndefined();
  });

  test("a task depending on itself never becomes runnable", () => {
    const plan = { kind: "task", nodeId: "self" };
    const descs = descriptorMap(makeDescriptor("self", { dependsOn: ["self"] }));
    const result = scheduleTasks(plan, new Map(), descs, new Map(), new Map(), 0);
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(true);
  });
});

describe("waitAsync traversal escape for waiting-event", () => {
  test("an async waiting-event task does not block later sequence siblings", () => {
    const plan = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "waiter" },
        { kind: "task", nodeId: "next" },
      ],
    };
    const descs = descriptorMap(makeDescriptor("waiter", { waitAsync: true }), makeDescriptor("next"));
    const result = scheduleTasks(plan, new Map([["waiter::0", "waiting-event"]]), descs, new Map(), new Map(), 0);
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["next"]);
    expect(result.waitingEventExists).toBe(true);
  });

  test("a synchronous waiting-event task still blocks the sequence", () => {
    const plan = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "waiter" },
        { kind: "task", nodeId: "next" },
      ],
    };
    const descs = descriptorMap(makeDescriptor("waiter"), makeDescriptor("next"));
    const result = scheduleTasks(plan, new Map([["waiter::0", "waiting-event"]]), descs, new Map(), new Map(), 0);
    expect(result.runnable).toEqual([]);
    expect(result.waitingEventExists).toBe(true);
  });
});
