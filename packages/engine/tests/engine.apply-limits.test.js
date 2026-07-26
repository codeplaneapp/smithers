import { describe, expect, test } from "bun:test";
import { applyConcurrencyLimits } from "../src/engine.js";
/**
 * @param {string} id
 * @param {string} [group]
 * @param {number} [cap]
 * @returns {TaskDescriptor}
 */
function td(id, group, cap) {
  return {
    nodeId: id,
    ordinal: 0,
    iteration: 0,
    ralphId: undefined,
    outputTable: null,
    outputTableName: "t",
    outputSchema: undefined,
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    continueOnFail: false,
    agent: undefined,
    prompt: undefined,
    staticPayload: undefined,
    label: undefined,
    meta: undefined,
    parallelGroupId: group,
    parallelMaxConcurrency: cap,
  };
}
/**
 * @param {string} id
 */
function key(id, it = 0) {
  return `${id}::${it}`;
}
describe("engine: applyConcurrencyLimits()", () => {
  test("respects global capacity regardless of group info", () => {
    const all = [td("x", "g", 1), td("a", "g", 1), td("b", "g", 1)];
    const runnable = [all[1], all[2]];
    const states = new Map([[key("x"), "in-progress"]]);
    // maxConcurrency=2 means only one new task admitted
    const selected = applyConcurrencyLimits(runnable, states, 2, all);
    expect(selected.length).toBe(1);
    expect(["a", "b"]).toContain(selected[0].nodeId);
  });
  test("admits up to remaining global capacity when none in-progress", () => {
    const all = [td("a"), td("b"), td("c")];
    const runnable = [all[0], all[1], all[2]];
    const states = new Map();
    const selected = applyConcurrencyLimits(runnable, states, 2, all);
    expect(selected.map((t) => t.nodeId).length).toBe(2);
    expect(["a", "b"]).toEqual(selected.map((t) => t.nodeId));
  });
  test("higher-priority runnable tasks claim scarce capacity first", () => {
    const all = [td("a"), { ...td("b"), priority: 5 }, { ...td("c"), priority: 1 }, { ...td("d"), priority: -2 }];
    const runnable = [...all];
    const selected = applyConcurrencyLimits(runnable, new Map(), 2, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["b", "c"]);
    // The caller's runnable array is left untouched.
    expect(runnable.map((t) => t.nodeId)).toEqual(["a", "b", "c", "d"]);
  });
  test("equal priorities keep input order (stable)", () => {
    const all = [
      { ...td("a"), priority: 1 },
      { ...td("b"), priority: 5 },
      { ...td("c"), priority: 1 },
      { ...td("d"), priority: 1 },
    ];
    const selected = applyConcurrencyLimits([...all], new Map(), 3, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["b", "a", "c"]);
  });
  test("all-default priorities select exactly the first capacity entries", () => {
    const all = [td("a"), td("b"), td("c"), td("d")];
    const selected = applyConcurrencyLimits([...all], new Map(), 3, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["a", "b", "c"]);
  });
  test("priority never bypasses capacity: in-progress tasks still count", () => {
    const all = [td("x"), { ...td("a"), priority: 100 }, { ...td("b"), priority: 50 }];
    const states = new Map([[key("x"), "in-progress"]]);
    const selected = applyConcurrencyLimits([all[1], all[2]], states, 2, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["a"]);
  });
});
