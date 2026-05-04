import { describe, expect, test } from "bun:test";
import { buildPlanTree } from "../src/buildPlanTree.js";
import { buildStateKey } from "../src/buildStateKey.js";
import { cloneTaskStateMap } from "../src/cloneTaskStateMap.js";
import { isTerminalState } from "../src/isTerminalState.js";
import { parseStateKey } from "../src/parseStateKey.js";
import { scheduleTasks } from "../src/scheduleTasks.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function text(value) {
  return { kind: "text", text: value };
}

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

function descriptorMap(...descriptors) {
  return new Map(descriptors.map((descriptor) => [descriptor.nodeId, descriptor]));
}

describe("state key helpers", () => {
  test("buildStateKey joins node id and iteration", () => {
    expect(buildStateKey("task", 2)).toBe("task::2");
  });

  test("parseStateKey returns iteration zero when separator is absent", () => {
    expect(parseStateKey("task")).toEqual({ nodeId: "task", iteration: 0 });
  });

  test("parseStateKey uses the last separator", () => {
    expect(parseStateKey("scope::task::3")).toEqual({
      nodeId: "scope::task",
      iteration: 3,
    });
  });

  test("parseStateKey falls back to zero for non-numeric iterations", () => {
    expect(parseStateKey("task::NaN")).toEqual({ nodeId: "task", iteration: 0 });
  });

  test("parseStateKey preserves negative finite iterations", () => {
    expect(parseStateKey("task::-1")).toEqual({ nodeId: "task", iteration: -1 });
  });

  test("parseStateKey preserves fractional finite iterations", () => {
    expect(parseStateKey("task::1.5")).toEqual({ nodeId: "task", iteration: 1.5 });
  });

  test("cloneTaskStateMap returns an independent Map", () => {
    const original = new Map([["a::0", "pending"]]);
    const cloned = cloneTaskStateMap(original);
    cloned.set("a::0", "finished");
    expect(original.get("a::0")).toBe("pending");
  });
});

describe("isTerminalState", () => {
  test("finished and skipped are always terminal", () => {
    expect(isTerminalState("finished")).toBe(true);
    expect(isTerminalState("skipped")).toBe(true);
  });

  test("failed is terminal only when descriptor continues on fail", () => {
    expect(isTerminalState("failed", { continueOnFail: true })).toBe(true);
    expect(isTerminalState("failed", { continueOnFail: false })).toBe(false);
    expect(isTerminalState("failed")).toBe(false);
  });

  test("active and waiting states are not terminal", () => {
    for (const state of [
      "pending",
      "in-progress",
      "waiting-approval",
      "waiting-event",
      "waiting-timer",
      "cancelled",
    ]) {
      expect(isTerminalState(state)).toBe(false);
    }
  });
});

describe("buildPlanTree", () => {
  test("null xml returns an empty plan", () => {
    expect(buildPlanTree(null)).toEqual({ plan: null, ralphs: [] });
  });

  test("text root returns null plan", () => {
    expect(buildPlanTree(text("hello"))).toEqual({ plan: null, ralphs: [] });
  });

  test("workflow becomes sequence and ignores text children", () => {
    const { plan } = buildPlanTree(
      el("smithers:workflow", {}, [
        text("ignore"),
        el("smithers:task", { id: "a" }),
      ]),
    );
    expect(plan).toEqual({
      kind: "sequence",
      children: [{ kind: "task", nodeId: "a" }],
    });
  });

  test("parallel and merge queue become parallel plan nodes", () => {
    expect(buildPlanTree(el("smithers:parallel")).plan).toEqual({
      kind: "parallel",
      children: [],
    });
    expect(buildPlanTree(el("smithers:merge-queue")).plan).toEqual({
      kind: "parallel",
      children: [],
    });
  });

  test("worktree becomes a group plan node", () => {
    expect(buildPlanTree(el("smithers:worktree")).plan).toEqual({
      kind: "group",
      children: [],
    });
  });

  test("inline subflow expands children instead of a task node", () => {
    const { plan } = buildPlanTree(
      el("smithers:subflow", { id: "sf", mode: "inline" }, [
        el("smithers:task", { id: "child" }),
      ]),
    );
    expect(plan).toEqual({
      kind: "sequence",
      children: [{ kind: "task", nodeId: "child" }],
    });
  });

  test("child-run subflow becomes a task node", () => {
    expect(buildPlanTree(el("smithers:subflow", { id: "sf" })).plan)
      .toEqual({ kind: "task", nodeId: "sf" });
  });

  test("sandbox wait-for-event and timer become task nodes", () => {
    for (const tag of [
      "smithers:sandbox",
      "smithers:wait-for-event",
      "smithers:timer",
    ]) {
      expect(buildPlanTree(el(tag, { id: tag })).plan).toEqual({
        kind: "task",
        nodeId: tag,
      });
    }
  });

  test("continue-as-new preserves state JSON", () => {
    expect(buildPlanTree(el("smithers:continue-as-new", { stateJson: '{"a":1}' })).plan)
      .toEqual({ kind: "continue-as-new", stateJson: '{"a":1}' });
  });

  test("ralph parses defaults and emits metadata", () => {
    const result = buildPlanTree(el("smithers:ralph", { id: "loop" }));
    expect(result.plan).toMatchObject({
      kind: "ralph",
      id: "loop",
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last",
    });
    expect(result.ralphs).toEqual([
      {
        id: "loop",
        until: false,
        maxIterations: 5,
        onMaxReached: "return-last",
        continueAsNewEvery: undefined,
      },
    ]);
  });

  test("ralph parses string props and initial state iteration", () => {
    const result = buildPlanTree(
      el("smithers:ralph", {
        id: "loop",
        until: "1",
        maxIterations: "7",
        onMaxReached: "fail",
        continueAsNewEvery: "3",
      }),
      new Map([["loop", { iteration: 4, done: false }]]),
    );
    expect(result.plan).toMatchObject({
      id: "loop",
      until: true,
      maxIterations: 7,
      onMaxReached: "fail",
      continueAsNewEvery: 3,
    });
  });

  test("duplicate ralph ids throw", () => {
    expect(() =>
      buildPlanTree(
        el("smithers:workflow", {}, [
          el("smithers:ralph", { id: "dup" }),
          el("smithers:ralph", { id: "dup" }),
        ]),
      ),
    ).toThrow(/Duplicate Ralph id/);
  });

  test("direct nested ralph throws", () => {
    expect(() =>
      buildPlanTree(
        el("smithers:ralph", { id: "outer" }, [
          el("smithers:ralph", { id: "inner" }),
        ]),
      ),
    ).toThrow(/Nested <Ralph>/);
  });

  test("saga partitions actions and compensations", () => {
    const { plan } = buildPlanTree(
      el("smithers:saga", { id: "s1", onFailure: "compensate-and-fail" }, [
        el("smithers:saga-actions", {}, [el("smithers:task", { id: "a" })]),
        el("smithers:saga-compensations", {}, [
          el("smithers:task", { id: "undo-a" }),
        ]),
      ]),
    );
    expect(plan).toEqual({
      kind: "saga",
      id: "s1",
      actionChildren: [{ kind: "task", nodeId: "a" }],
      compensationChildren: [{ kind: "task", nodeId: "undo-a" }],
      onFailure: "compensate-and-fail",
    });
  });

  test("try-catch-finally partitions children", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { id: "tcf" }, [
        el("smithers:tcf-try", {}, [el("smithers:task", { id: "try" })]),
        el("smithers:tcf-catch", {}, [el("smithers:task", { id: "catch" })]),
        el("smithers:tcf-finally", {}, [el("smithers:task", { id: "finally" })]),
      ]),
    );
    expect(plan).toEqual({
      kind: "try-catch-finally",
      id: "tcf",
      tryChildren: [{ kind: "task", nodeId: "try" }],
      catchChildren: [{ kind: "task", nodeId: "catch" }],
      finallyChildren: [{ kind: "task", nodeId: "finally" }],
    });
  });
});

describe("scheduleTasks boundaries", () => {
  test("missing descriptor is treated as terminal", () => {
    const result = scheduleTasks(
      { kind: "task", nodeId: "missing" },
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
  });

  test("dependencies must exist and be terminal", () => {
    const plan = { kind: "task", nodeId: "child" };
    const child = makeDescriptor("child", { dependsOn: ["parent"] });
    const result = scheduleTasks(
      plan,
      new Map(),
      descriptorMap(child),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(true);
  });

  test("finished dependency allows child to run", () => {
    const parent = makeDescriptor("parent");
    const child = makeDescriptor("child", { dependsOn: ["parent"] });
    const result = scheduleTasks(
      { kind: "task", nodeId: "child" },
      new Map([[buildStateKey("parent", 0), "finished"]]),
      descriptorMap(parent, child),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["child"]);
  });

  test("failed continueOnFail dependency allows child to run", () => {
    const parent = makeDescriptor("parent", { continueOnFail: true });
    const child = makeDescriptor("child", { dependsOn: ["parent"] });
    const result = scheduleTasks(
      { kind: "task", nodeId: "child" },
      new Map([[buildStateKey("parent", 0), "failed"]]),
      descriptorMap(parent, child),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["child"]);
  });

  test("future retry wait blocks runnable and reports next retry", () => {
    const descriptor = makeDescriptor("retry");
    const result = scheduleTasks(
      { kind: "task", nodeId: "retry" },
      new Map(),
      descriptorMap(descriptor),
      new Map(),
      new Map([[buildStateKey("retry", 0), 1000]]),
      999,
    );
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(true);
    expect(result.nextRetryAtMs).toBe(1000);
  });

  test("expired retry wait allows runnable", () => {
    const descriptor = makeDescriptor("retry");
    const result = scheduleTasks(
      { kind: "task", nodeId: "retry" },
      new Map(),
      descriptorMap(descriptor),
      new Map(),
      new Map([[buildStateKey("retry", 0), 1000]]),
      1000,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["retry"]);
  });

  test("waiting flags are surfaced", () => {
    const descriptors = descriptorMap(
      makeDescriptor("approval"),
      makeDescriptor("event"),
      makeDescriptor("timer"),
    );
    const states = new Map([
      [buildStateKey("approval", 0), "waiting-approval"],
      [buildStateKey("event", 0), "waiting-event"],
      [buildStateKey("timer", 0), "waiting-timer"],
    ]);
    const result = scheduleTasks(
      {
        kind: "parallel",
        children: [
          { kind: "task", nodeId: "approval" },
          { kind: "task", nodeId: "event" },
          { kind: "task", nodeId: "timer" },
        ],
      },
      states,
      descriptors,
      new Map(),
      new Map(),
      0,
    );
    expect(result.waitingApprovalExists).toBe(true);
    expect(result.waitingEventExists).toBe(true);
    expect(result.waitingTimerExists).toBe(true);
  });

  test("waitAsync approval is traversal-terminal", () => {
    const descriptor = makeDescriptor("approval", { waitAsync: true });
    const result = scheduleTasks(
      {
        kind: "sequence",
        children: [
          { kind: "task", nodeId: "approval" },
          { kind: "task", nodeId: "after" },
        ],
      },
      new Map([[buildStateKey("approval", 0), "waiting-approval"]]),
      descriptorMap(descriptor, makeDescriptor("after")),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["after"]);
  });

  test("continue-as-new records continuation request", () => {
    const result = scheduleTasks(
      { kind: "continue-as-new", stateJson: '{"step":2}' },
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
    );
    expect(result.continuation).toEqual({ stateJson: '{"step":2}' });
  });

  test("ralph with terminal children becomes ready", () => {
    const descriptor = makeDescriptor("child");
    const result = scheduleTasks(
      {
        kind: "ralph",
        id: "loop",
        until: false,
        maxIterations: 5,
        onMaxReached: "return-last",
        children: [{ kind: "task", nodeId: "child" }],
      },
      new Map([[buildStateKey("child", 0), "finished"]]),
      descriptorMap(descriptor),
      new Map(),
      new Map(),
      0,
    );
    expect(result.readyRalphs).toEqual([
      {
        id: "loop",
        until: false,
        maxIterations: 5,
        onMaxReached: "return-last",
        continueAsNewEvery: undefined,
      },
    ]);
  });

  test("ralph with until=true is terminal and not ready", () => {
    const result = scheduleTasks(
      {
        kind: "ralph",
        id: "loop",
        until: true,
        maxIterations: 5,
        onMaxReached: "return-last",
        children: [],
      },
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      0,
    );
    expect(result.readyRalphs).toEqual([]);
  });

  test("saga failure schedules completed action compensation", () => {
    const result = scheduleTasks(
      {
        kind: "saga",
        id: "saga",
        onFailure: "compensate",
        actionChildren: [
          { kind: "task", nodeId: "a" },
          { kind: "task", nodeId: "b" },
        ],
        compensationChildren: [
          { kind: "task", nodeId: "undo-a" },
          { kind: "task", nodeId: "undo-b" },
        ],
      },
      new Map([
        [buildStateKey("a", 0), "finished"],
        [buildStateKey("b", 0), "failed"],
      ]),
      descriptorMap(
        makeDescriptor("a"),
        makeDescriptor("b"),
        makeDescriptor("undo-a"),
        makeDescriptor("undo-b"),
      ),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["undo-a"]);
  });

  test("try-catch-finally schedules catch after try failure", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [{ kind: "task", nodeId: "catch" }],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([[buildStateKey("try", 0), "failed"]]),
      descriptorMap(
        makeDescriptor("try"),
        makeDescriptor("catch"),
        makeDescriptor("finally"),
      ),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["catch"]);
  });

  test("try failure without catch records fatal error after finally", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [],
        finallyChildren: [],
      },
      new Map([[buildStateKey("try", 0), "failed"]]),
      descriptorMap(makeDescriptor("try")),
      new Map(),
      new Map(),
      0,
    );
    expect(result.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("try failure without catch schedules finally before fatal error", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([[buildStateKey("try", 0), "failed"]]),
      descriptorMap(makeDescriptor("try"), makeDescriptor("finally")),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["finally"]);
    expect(result.fatalError).toBeUndefined();
    expect(result.failureRecoveryActive).toBe(true);
  });

  test("try-catch-finally schedules finally before surfacing catch failure", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [{ kind: "task", nodeId: "catch" }],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([
        [buildStateKey("try", 0), "failed"],
        [buildStateKey("catch", 0), "failed"],
      ]),
      descriptorMap(
        makeDescriptor("try"),
        makeDescriptor("catch"),
        makeDescriptor("finally"),
      ),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable.map((task) => task.nodeId)).toEqual(["finally"]);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("try", 0));
    expect(result.failureRecoveryKeys).toContain(buildStateKey("catch", 0));
  });

  test("try-catch-finally surfaces catch failure after finally finishes", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "tcf",
        tryChildren: [{ kind: "task", nodeId: "try" }],
        catchChildren: [{ kind: "task", nodeId: "catch" }],
        finallyChildren: [{ kind: "task", nodeId: "finally" }],
      },
      new Map([
        [buildStateKey("try", 0), "failed"],
        [buildStateKey("catch", 0), "failed"],
        [buildStateKey("finally", 0), "finished"],
      ]),
      descriptorMap(
        makeDescriptor("try"),
        makeDescriptor("catch"),
        makeDescriptor("finally"),
      ),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("try", 0));
    expect(result.failureRecoveryKeys).not.toContain(buildStateKey("catch", 0));
  });

  test("outer try-catch-finally does not catch an inner recovered failure", () => {
    const result = scheduleTasks(
      {
        kind: "try-catch-finally",
        id: "outer",
        tryChildren: [
          {
            kind: "try-catch-finally",
            id: "inner",
            tryChildren: [{ kind: "task", nodeId: "inner-try" }],
            catchChildren: [{ kind: "task", nodeId: "inner-catch" }],
            finallyChildren: [],
          },
        ],
        catchChildren: [{ kind: "task", nodeId: "outer-catch" }],
        finallyChildren: [],
      },
      new Map([
        [buildStateKey("inner-try", 0), "failed"],
        [buildStateKey("inner-catch", 0), "finished"],
      ]),
      descriptorMap(
        makeDescriptor("inner-try"),
        makeDescriptor("inner-catch"),
        makeDescriptor("outer-catch"),
      ),
      new Map(),
      new Map(),
      0,
    );
    expect(result.runnable).toEqual([]);
    expect(result.failureRecoveryKeys).toEqual([]);
  });
});
