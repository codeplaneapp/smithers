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

/** @param {string[]} nodeIds */
function parallelPlan(...nodeIds) {
  return {
    kind: "parallel",
    children: nodeIds.map((nodeId) => ({ kind: "task", nodeId })),
  };
}

describe("scheduleTasks priority ordering", () => {
  test("orders runnable by priority descending", () => {
    const descriptors = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("b", { priority: 5 }),
      makeDescriptor("c", { priority: 1 }),
      makeDescriptor("d", { priority: -2 }),
    );
    const result = scheduleTasks(
      parallelPlan("a", "b", "c", "d"),
      new Map(),
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["b", "c", "a", "d"]);
  });

  test("equal priorities keep plan-walk order (stable)", () => {
    const descriptors = descriptorMap(
      makeDescriptor("a", { priority: 1 }),
      makeDescriptor("b", { priority: 5 }),
      makeDescriptor("c", { priority: 1 }),
      makeDescriptor("d", { priority: 1 }),
    );
    const result = scheduleTasks(
      parallelPlan("a", "b", "c", "d"),
      new Map(),
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["b", "a", "c", "d"]);
  });

  test("all-default priorities preserve plan-walk order exactly", () => {
    const descriptors = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("b"),
      makeDescriptor("c"),
    );
    const result = scheduleTasks(
      parallelPlan("a", "b", "c"),
      new Map(),
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["a", "b", "c"]);
  });

  test("priority never makes a task with unsatisfied deps runnable", () => {
    const descriptors = descriptorMap(
      makeDescriptor("gate"),
      makeDescriptor("urgent", { priority: 100, dependsOn: ["gate"] }),
      makeDescriptor("normal"),
    );
    const result = scheduleTasks(
      parallelPlan("gate", "urgent", "normal"),
      new Map(),
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    // "urgent" depends on the unfinished "gate": it must not appear at all,
    // no matter its priority.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["gate", "normal"]);
  });

  test("priority never bypasses a parallel group cap", () => {
    const descriptors = descriptorMap(
      makeDescriptor("running", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      makeDescriptor("urgent", { priority: 100, parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      makeDescriptor("outside"),
    );
    const states = new Map([[buildStateKey("running", 0), "in-progress"]]);
    const result = scheduleTasks(
      parallelPlan("running", "urgent", "outside"),
      states,
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["outside"]);
  });
});
