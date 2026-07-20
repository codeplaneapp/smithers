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

describe("fork acts as a dependency", () => {
  test("forked task is not runnable until its source completes", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("b", { forkSource: "a" }),
    );
    const states = new Map([
      [buildStateKey("a", 0), "in-progress"],
      [buildStateKey("b", 0), "pending"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual([]);
    expect(result.pendingExists).toBe(true);
  });

  test("forked task becomes runnable once its source finishes", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("b", { forkSource: "a" }),
    );
    const states = new Map([
      [buildStateKey("a", 0), "finished"],
      [buildStateKey("b", 0), "pending"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("multiple tasks can fork the same source in parallel", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "base" },
        { kind: "task", nodeId: "left" },
        { kind: "task", nodeId: "right" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("base"),
      makeDescriptor("left", { forkSource: "base" }),
      makeDescriptor("right", { forkSource: "base" }),
    );
    const states = new Map([
      [buildStateKey("base", 0), "finished"],
      [buildStateKey("left", 0), "pending"],
      [buildStateKey("right", 0), "pending"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(new Set(result.runnable.map((r) => r.nodeId))).toEqual(
      new Set(["left", "right"]),
    );
  });

  test("fork composes with explicit dependsOn (both must be satisfied)", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "gate" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("gate"),
      makeDescriptor("b", { forkSource: "a", dependsOn: ["gate"] }),
    );
    // Source finished but explicit dep still running → b waits.
    const blocked = scheduleTasks(
      plan,
      new Map([
        [buildStateKey("a", 0), "finished"],
        [buildStateKey("gate", 0), "in-progress"],
        [buildStateKey("b", 0), "pending"],
      ]),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(blocked.runnable.map((r) => r.nodeId)).toEqual([]);
    // Both satisfied → b runnable.
    const ready = scheduleTasks(
      plan,
      new Map([
        [buildStateKey("a", 0), "finished"],
        [buildStateKey("gate", 0), "finished"],
        [buildStateKey("b", 0), "pending"],
      ]),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(ready.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("fork source matched by logical id across loop iterations", () => {
    // Source ran inside a loop (scoped node id) and finished; the forked task
    // references the logical id and should be satisfied by the completed
    // iteration.
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "draft@@loop=0" },
        { kind: "task", nodeId: "review" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("draft@@loop=0", { iteration: 0 }),
      makeDescriptor("review", { forkSource: "draft" }),
    );
    const states = new Map([
      [buildStateKey("draft@@loop=0", 0), "finished"],
      [buildStateKey("review", 0), "pending"],
    ]);
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["review"]);
  });
});
