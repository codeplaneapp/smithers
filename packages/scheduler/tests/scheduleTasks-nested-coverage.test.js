import { describe, expect, test } from "bun:test";
import { scheduleTasks } from "../src/scheduleTasks.js";
import { buildStateKey } from "../src/buildStateKey.js";

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

/** Build a TaskStateMap from a plain object of { nodeId: state }. */
function states(obj) {
  return new Map(Object.entries(obj).map(([nodeId, state]) => [buildStateKey(nodeId, 0), state]));
}

function task(nodeId) {
  return { kind: "task", nodeId };
}

function sched(plan, stateObj, descriptors, ralphState = new Map()) {
  return scheduleTasks(plan, states(stateObj), descriptors, ralphState, new Map(), 0);
}

// A saga nested inside a try region forces scheduleTasks to *inspect* the saga
// (rather than walk it), exercising the saga arm of inspect().
function tcfWrappingSaga(saga, { catchChildren = [], finallyChildren = [] } = {}) {
  return { kind: "try-catch-finally", id: "tcf", tryChildren: [saga], catchChildren, finallyChildren };
}

describe("scheduleTasks inspect() saga arm", () => {
  test("a fully finished nested saga inspects as terminal and non-failed", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa")],
      compensationChildren: [task("ca")],
    };
    const result = sched(
      tcfWrappingSaga(saga, { finallyChildren: [task("fin")] }),
      { sa: "finished", fin: "pending" },
      descriptorMap(makeDescriptor("sa"), makeDescriptor("ca"), makeDescriptor("fin")),
    );
    // The saga is terminal & clean, so the try does not fail and finally runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["fin"]);
  });

  test("a failed action in an onFailure=fail nested saga inspects as failed", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "fail",
      actionChildren: [task("sa")],
      compensationChildren: [],
    };
    const result = sched(tcfWrappingSaga(saga), { sa: "failed" }, descriptorMap(makeDescriptor("sa")));
    expect(result.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("a compensated nested saga inspects as recovered (non-failed)", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca"), task("cb")],
    };
    const result = sched(
      tcfWrappingSaga(saga, { finallyChildren: [task("fin")] }),
      { sa: "finished", sb: "failed", ca: "finished", cb: "finished", fin: "pending" },
      descriptorMap(
        makeDescriptor("sa"),
        makeDescriptor("sb"),
        makeDescriptor("ca"),
        makeDescriptor("cb"),
        makeDescriptor("fin"),
      ),
    );
    // Saga recovered → try did not fail → finally runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["fin"]);
  });

  test("a nested saga whose compensation failed inspects as failed", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca")],
    };
    const result = sched(
      tcfWrappingSaga(saga, { catchChildren: [task("c")] }),
      { sa: "finished", sb: "failed", ca: "failed", c: "pending" },
      descriptorMap(makeDescriptor("sa"), makeDescriptor("sb"), makeDescriptor("ca"), makeDescriptor("c")),
    );
    // Saga inspects failed → try failed → catch runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
  });

  test("a nested saga with a still-running action inspects as non-terminal", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa")],
      compensationChildren: [],
    };
    const result = sched(tcfWrappingSaga(saga), { sa: "pending" }, descriptorMap(makeDescriptor("sa")));
    // Non-terminal saga → try region falls back to walking the saga → action runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["sa"]);
  });

  test("a nested saga with a still-running compensation inspects as non-terminal", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca")],
    };
    const result = sched(
      tcfWrappingSaga(saga, { catchChildren: [task("c")] }),
      { sa: "finished", sb: "failed", ca: "pending" },
      descriptorMap(makeDescriptor("sa"), makeDescriptor("sb"), makeDescriptor("ca"), makeDescriptor("c")),
    );
    // Compensation still pending → saga non-terminal → walked → compensation runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["ca"]);
  });
});

describe("scheduleTasks inspect() try-catch-finally arm", () => {
  function outer(innerTcf, extra = {}) {
    return {
      kind: "try-catch-finally",
      id: "outer",
      tryChildren: [innerTcf],
      catchChildren: extra.catchChildren ?? [],
      finallyChildren: extra.finallyChildren ?? [],
    };
  }

  test("a nested tcf whose try succeeded inspects its finally region", () => {
    const inner = {
      kind: "try-catch-finally",
      id: "inner",
      tryChildren: [task("it")],
      catchChildren: [],
      finallyChildren: [task("if_")],
    };
    const result = sched(
      outer(inner),
      { it: "finished", if_: "pending" },
      descriptorMap(makeDescriptor("it"), makeDescriptor("if_")),
    );
    // Inner finally still pending → inner non-terminal → walked → finally runs.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["if_"]);
  });

  test("a nested tcf whose try failed inspects the catch region and recovers", () => {
    const inner = {
      kind: "try-catch-finally",
      id: "inner",
      tryChildren: [task("it")],
      catchChildren: [task("ic")],
      finallyChildren: [],
    };
    const result = sched(
      outer(inner),
      { it: "failed", ic: "finished" },
      descriptorMap(makeDescriptor("it"), makeDescriptor("ic")),
    );
    // Inner recovered via catch → nothing else to run.
    expect(result.runnable).toEqual([]);
  });
});

describe("scheduleTasks inspect() ralph and continue-as-new arms", () => {
  test("a nested not-done ralph inspects as non-terminal", () => {
    const ralph = {
      kind: "ralph",
      id: "r",
      until: false,
      maxIterations: 5,
      onMaxReached: "return-last",
      children: [task("rc")],
    };
    const result = sched(tcfWrappingSaga(ralph), { rc: "pending" }, descriptorMap(makeDescriptor("rc")));
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["rc"]);
  });

  test("a nested done ralph with a finished child inspects as terminal & clean", () => {
    const ralph = {
      kind: "ralph",
      id: "r",
      until: true,
      maxIterations: 5,
      onMaxReached: "return-last",
      children: [task("rc")],
    };
    const result = sched(
      tcfWrappingSaga(ralph, { finallyChildren: [task("fin")] }),
      { rc: "finished", fin: "pending" },
      descriptorMap(makeDescriptor("rc"), makeDescriptor("fin")),
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["fin"]);
  });

  test("a nested done ralph with a failed child inspects as failed", () => {
    const ralph = {
      kind: "ralph",
      id: "r",
      until: true,
      maxIterations: 5,
      onMaxReached: "return-last",
      children: [task("rc")],
    };
    const result = sched(
      tcfWrappingSaga(ralph, { catchChildren: [task("c")] }),
      { rc: "failed", c: "pending" },
      descriptorMap(makeDescriptor("rc"), makeDescriptor("c")),
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
  });

  test("a nested done ralph with a still-running child inspects as non-terminal", () => {
    const ralph = {
      kind: "ralph",
      id: "r",
      until: true,
      maxIterations: 5,
      onMaxReached: "return-last",
      children: [task("rc")],
    };
    const result = sched(tcfWrappingSaga(ralph), { rc: "in-progress" }, descriptorMap(makeDescriptor("rc")));
    // ralph inspected non-terminal → walked → child in-progress, nothing runnable.
    expect(result.runnable).toEqual([]);
  });

  test("a nested continue-as-new inspects as non-terminal", () => {
    const can = { kind: "continue-as-new", stateJson: "{}" };
    const result = sched(tcfWrappingSaga(can), {}, descriptorMap());
    expect(result.continuation).toEqual({ stateJson: "{}" });
  });
});

describe("scheduleTasks collectFailureKeys arms", () => {
  test("a try region built from composite nodes collects every failed leaf", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "tcf",
      tryChildren: [
        { kind: "parallel", children: [task("pa"), task("pb")] },
        { kind: "sequence", children: [task("sq")] },
        { kind: "group", children: [task("gp")] },
        { kind: "saga", id: "s", onFailure: "compensate", actionChildren: [task("sa")], compensationChildren: [] },
        { kind: "ralph", id: "r", until: false, maxIterations: 5, onMaxReached: "return-last", children: [task("rc")] },
        {
          kind: "try-catch-finally",
          id: "inner",
          tryChildren: [task("it")],
          catchChildren: [task("icx")],
          finallyChildren: [task("ifx")],
        },
      ],
      catchChildren: [task("c")],
      finallyChildren: [],
    };
    const result = sched(
      plan,
      {
        pa: "failed",
        pb: "failed",
        sq: "failed",
        gp: "failed",
        sa: "failed",
        rc: "failed",
        it: "failed",
        icx: "failed",
        ifx: "failed",
        c: "pending",
      },
      descriptorMap(
        makeDescriptor("pa"),
        makeDescriptor("pb"),
        makeDescriptor("sq"),
        makeDescriptor("gp"),
        makeDescriptor("sa"),
        makeDescriptor("rc"),
        makeDescriptor("it"),
        makeDescriptor("icx"),
        makeDescriptor("ifx"),
        makeDescriptor("c"),
      ),
    );
    // The parallel try child fails first, driving the catch region and the
    // collect-all pass over every composite try child.
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("pa", 0));
    expect(result.failureRecoveryKeys).toContain(buildStateKey("sa", 0));
    expect(result.failureRecoveryKeys).toContain(buildStateKey("rc", 0));
    expect(result.failureRecoveryKeys).toContain(buildStateKey("it", 0));
  });
});

describe("scheduleTasks saga walk failure arms", () => {
  test("an onFailure=fail saga records a fatal error", () => {
    const plan = {
      kind: "saga",
      id: "s",
      onFailure: "fail",
      actionChildren: [task("sa")],
      compensationChildren: [],
    };
    const result = sched(plan, { sa: "failed" }, descriptorMap(makeDescriptor("sa")));
    expect(result.fatalError).toBe("Saga s failed");
  });

  test("a saga whose compensation already failed does not settle", () => {
    const plan = {
      kind: "saga",
      id: "s",
      onFailure: "compensate",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca"), task("cb")],
    };
    const result = sched(
      plan,
      { sa: "finished", sb: "failed", ca: "failed" },
      descriptorMap(makeDescriptor("sa"), makeDescriptor("sb"), makeDescriptor("ca"), makeDescriptor("cb")),
    );
    // Compensation for the completed action failed → saga cannot settle yet.
    expect(result.runnable).toEqual([]);
    expect(result.fatalError).toBeUndefined();
  });

  test("a compensate-and-fail saga surfaces a fatal error once compensation completes", () => {
    const plan = {
      kind: "saga",
      id: "s",
      onFailure: "compensate-and-fail",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca"), task("cb")],
    };
    const result = sched(
      plan,
      { sa: "finished", sb: "failed", ca: "finished" },
      descriptorMap(makeDescriptor("sa"), makeDescriptor("sb"), makeDescriptor("ca"), makeDescriptor("cb")),
    );
    expect(result.fatalError).toBe("Saga s failed");
    expect(result.failureRecoveryActive).toBe(true);
  });
});

describe("scheduleTasks try-catch-finally walk finally-failure arms", () => {
  test("a failing finally after a catch defers the run", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "tcf",
      tryChildren: [task("t")],
      catchChildren: [task("c")],
      finallyChildren: [task("f")],
    };
    const result = sched(
      plan,
      { t: "failed", c: "finished", f: "failed" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c"), makeDescriptor("f")),
    );
    expect(result.runnable).toEqual([]);
    expect(result.failureRecoveryActive).toBe(false);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("t", 0));
  });

  test("a failing finally after a catch-less try defers the run", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "tcf",
      tryChildren: [task("t")],
      catchChildren: [],
      finallyChildren: [task("f")],
    };
    const result = sched(plan, { t: "failed", f: "failed" }, descriptorMap(makeDescriptor("t"), makeDescriptor("f")));
    expect(result.runnable).toEqual([]);
    expect(result.failureRecoveryActive).toBe(false);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("t", 0));
  });
});

describe("scheduleTasks group walk", () => {
  test("a group schedules its runnable children", () => {
    const plan = { kind: "group", children: [task("g1"), task("g2")] };
    const result = sched(
      plan,
      { g1: "pending", g2: "pending" },
      descriptorMap(makeDescriptor("g1"), makeDescriptor("g2")),
    );
    expect(result.runnable.map((t) => t.nodeId).sort()).toEqual(["g1", "g2"]);
  });
});
