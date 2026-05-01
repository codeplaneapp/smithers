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

describe("scheduleTasks input shapes", () => {
  test("empty plan: returns no runnables, no flags", () => {
    const result = scheduleTasks(
      null,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
    expect(result.waitingApprovalExists).toBe(false);
    expect(result.waitingEventExists).toBe(false);
    expect(result.waitingTimerExists).toBe(false);
    expect(result.readyRalphs).toEqual([]);
    expect(result.continuation).toBeUndefined();
    expect(result.nextRetryAtMs).toBeUndefined();
    expect(result.fatalError).toBeUndefined();
  });

  test("single task plan: returns the single task as runnable", () => {
    const plan = { kind: "task", nodeId: "only" };
    const descs = descriptorMap(makeDescriptor("only"));
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["only"]);
    expect(result.pendingExists).toBe(true);
  });

  test("large parallel batch: dispatches all tasks", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const plan = {
      kind: "parallel",
      children: ids.map((id) => ({ kind: "task", nodeId: id })),
    };
    const descs = descriptorMap(...ids.map((id) => makeDescriptor(id)));
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(100);
    expect(new Set(result.runnable.map((r) => r.nodeId)).size).toBe(100);
  });
});

describe("scheduleTasks queue / FIFO ordering", () => {
  test("FIFO at equal priority — sequence dispatches in declared order", () => {
    const plan = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "first" },
        { kind: "task", nodeId: "second" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("first"),
      makeDescriptor("second"),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    // sequence runs first task only
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["first"]);
  });

  test("parallel preserves declared order in runnable list", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a"),
      makeDescriptor("b"),
      makeDescriptor("c"),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });
});

describe("scheduleTasks concurrency cap", () => {
  test("respects parallelMaxConcurrency=1: only one admitted", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      makeDescriptor("b", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      makeDescriptor("c", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(1);
    expect(result.pendingExists).toBe(true);
  });

  test("respects parallelMaxConcurrency=2: two admitted, third waits", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
        { kind: "task", nodeId: "c" },
      ],
    };
    const descs = descriptorMap(
      ...["a", "b", "c"].map((id) =>
        makeDescriptor(id, {
          parallelGroupId: "g",
          parallelMaxConcurrency: 2,
        }),
      ),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(2);
  });

  test("in-progress tasks count against the cap", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states = new Map([[buildStateKey("a", 0), "in-progress"]]);
    const descs = descriptorMap(
      makeDescriptor("a", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      makeDescriptor("b", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
    );
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.length).toBe(0);
    expect(result.pendingExists).toBe(true);
  });

  test("parallelMaxConcurrency=0 admits no tasks", () => {
    const plan = {
      kind: "parallel",
      children: [{ kind: "task", nodeId: "a" }],
    };
    const descs = descriptorMap(
      makeDescriptor("a", {
        parallelGroupId: "g",
        parallelMaxConcurrency: 0,
      }),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(0);
    expect(result.pendingExists).toBe(true);
  });

  test("negative parallelMaxConcurrency admits no tasks", () => {
    // Implementation compares `used >= cap` — for cap=-1 used=0 means
    // 0 >= -1 → true → no admission. Documents current behavior.
    const plan = {
      kind: "parallel",
      children: [{ kind: "task", nodeId: "a" }],
    };
    const descs = descriptorMap(
      makeDescriptor("a", {
        parallelGroupId: "g",
        parallelMaxConcurrency: -1,
      }),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(0);
  });

  test("cap is per parallelGroupId — separate groups don't share quota", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(
      makeDescriptor("a", { parallelGroupId: "g1", parallelMaxConcurrency: 1 }),
      makeDescriptor("b", { parallelGroupId: "g2", parallelMaxConcurrency: 1 }),
    );
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.length).toBe(2);
  });
});

describe("scheduleTasks cancellation semantics", () => {
  test("cancelled task can re-enter as pending; siblings unaffected", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states = new Map([
      [buildStateKey("a", 0), "cancelled"],
      [buildStateKey("b", 0), "in-progress"],
    ]);
    const descs = descriptorMap(makeDescriptor("a"), makeDescriptor("b"));
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // "a" is cancelled and treated like pending — eligible to run again.
    // "b" is in-progress, so not in runnable.
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a"]);
  });

  test("cancelling one task does not stop sibling parallel tasks from being scheduled", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states = new Map([[buildStateKey("a", 0), "cancelled"]]);
    const descs = descriptorMap(makeDescriptor("a"), makeDescriptor("b"));
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    // both should be runnable: a (re-enters as cancelled→pending), b (pending)
    expect(result.runnable.map((r) => r.nodeId).sort()).toEqual(["a", "b"]);
  });
});

describe("scheduleTasks rescheduling after failure (retry wait)", () => {
  test("task with future retry-wait is deferred", () => {
    const plan = { kind: "task", nodeId: "a" };
    const descs = descriptorMap(makeDescriptor("a"));
    const retryWait = new Map([[buildStateKey("a", 0), 5_000]]);
    const result = scheduleTasks(plan, new Map(), descs, new Map(), retryWait, 1_000);
    expect(result.runnable.length).toBe(0);
    expect(result.nextRetryAtMs).toBe(5_000);
    expect(result.pendingExists).toBe(true);
  });

  test("task whose retry-wait has passed is admitted", () => {
    const plan = { kind: "task", nodeId: "a" };
    const descs = descriptorMap(makeDescriptor("a"));
    const retryWait = new Map([[buildStateKey("a", 0), 1_000]]);
    const result = scheduleTasks(plan, new Map(), descs, new Map(), retryWait, 5_000);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["a"]);
  });

  test("nextRetryAtMs is the earliest pending retry across siblings", () => {
    const plan = {
      kind: "parallel",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const descs = descriptorMap(makeDescriptor("a"), makeDescriptor("b"));
    const retryWait = new Map([
      [buildStateKey("a", 0), 9_000],
      [buildStateKey("b", 0), 4_000],
    ]);
    const result = scheduleTasks(
      plan,
      new Map(),
      descs,
      new Map(),
      retryWait,
      1_000,
    );
    expect(result.nextRetryAtMs).toBe(4_000);
  });

  test("failed task with continueOnFail does not gate sibling reschedules", () => {
    const plan = {
      kind: "sequence",
      children: [
        { kind: "task", nodeId: "a" },
        { kind: "task", nodeId: "b" },
      ],
    };
    const states = new Map([[buildStateKey("a", 0), "failed"]]);
    const descs = descriptorMap(
      makeDescriptor("a", { continueOnFail: true }),
      makeDescriptor("b"),
    );
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["b"]);
  });

  test("failed task with continueOnFail triggers try catch inside boundary", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "safe-try",
      tryChildren: [
        {
          kind: "parallel",
          children: [
            { kind: "task", nodeId: "a" },
            { kind: "task", nodeId: "b" },
          ],
        },
      ],
      catchChildren: [{ kind: "task", nodeId: "catch" }],
      finallyChildren: [],
    };
    const states = new Map([
      [buildStateKey("a", 0), "failed"],
      [buildStateKey("b", 0), "finished"],
    ]);
    const descs = descriptorMap(
      makeDescriptor("a", { continueOnFail: true }),
      makeDescriptor("b"),
      makeDescriptor("catch"),
    );
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.runnable.map((r) => r.nodeId)).toEqual(["catch"]);
    expect(result.fatalError).toBeUndefined();
  });
});

describe("scheduleTasks waiting-state flags", () => {
  test("waiting-approval is reported", () => {
    const plan = { kind: "task", nodeId: "a" };
    const states = new Map([[buildStateKey("a", 0), "waiting-approval"]]);
    const descs = descriptorMap(makeDescriptor("a"));
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.waitingApprovalExists).toBe(true);
  });

  test("waiting-event is reported", () => {
    const plan = { kind: "task", nodeId: "a" };
    const states = new Map([[buildStateKey("a", 0), "waiting-event"]]);
    const descs = descriptorMap(makeDescriptor("a"));
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.waitingEventExists).toBe(true);
  });

  test("waiting-timer is reported", () => {
    const plan = { kind: "task", nodeId: "a" };
    const states = new Map([[buildStateKey("a", 0), "waiting-timer"]]);
    const descs = descriptorMap(makeDescriptor("a"));
    const result = scheduleTasks(plan, states, descs, new Map(), new Map(), 0);
    expect(result.waitingTimerExists).toBe(true);
  });
});
