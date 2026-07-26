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

/** Build a task-failure map from a plain object of { nodeId: failurePayload }. */
function failures(obj) {
  return new Map(Object.entries(obj).map(([nodeId, payload]) => [buildStateKey(nodeId, 0), payload]));
}

function task(nodeId) {
  return { kind: "task", nodeId };
}

function tcf(id, tryChildren, { catchChildren = [], finallyChildren = [], catchErrors } = {}) {
  return { kind: "try-catch-finally", id, tryChildren, catchChildren, finallyChildren, catchErrors };
}

function sched(plan, stateObj, descriptors, { taskFailures, ralphState } = {}) {
  return scheduleTasks(plan, states(stateObj), descriptors, ralphState ?? new Map(), new Map(), 0, taskFailures);
}

describe("scheduleTasks <TryCatchFinally catchErrors> code matching", () => {
  test("a failed try task whose recorded code matches catchErrors arms the catch", () => {
    const result = sched(
      tcf("tcf", [task("t")], { catchChildren: [task("c")], catchErrors: ["E_BOOM"] }),
      { t: "failed", c: "pending" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
      { taskFailures: failures({ t: { code: "E_BOOM" } }) },
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.fatalError).toBeUndefined();
  });

  test("a failure code outside catchErrors leaves the catch disarmed and the boundary fails", () => {
    const result = sched(
      tcf("tcf", [task("t")], { catchChildren: [task("c")], catchErrors: ["E_OTHER"] }),
      { t: "failed", c: "pending" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
      { taskFailures: failures({ t: { code: "E_BOOM" } }) },
    );
    expect(result.runnable).toEqual([]);
    expect(result.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("a failure payload without a string code never matches a catchErrors filter", () => {
    for (const payload of [{ message: "boom" }, "boom", { code: 42 }, null]) {
      const result = sched(
        tcf("tcf", [task("t")], { catchChildren: [task("c")], catchErrors: ["E_BOOM"] }),
        { t: "failed", c: "pending" },
        descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
        { taskFailures: failures({ t: payload }) },
      );
      expect(result.runnable).toEqual([]);
      expect(result.fatalError).toBe("TryCatchFinally tcf failed");
    }
  });

  test("with no taskFailures map at all a catchErrors filter stays disarmed", () => {
    const result = sched(
      tcf("tcf", [task("t")], { catchChildren: [task("c")], catchErrors: ["E_BOOM"] }),
      { t: "failed", c: "pending" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
    );
    expect(result.runnable).toEqual([]);
    expect(result.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("an empty catchErrors array behaves as an unfiltered catch", () => {
    const result = sched(
      tcf("tcf", [task("t")], { catchChildren: [task("c")], catchErrors: [] }),
      { t: "failed", c: "pending" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.fatalError).toBeUndefined();
  });

  test("only failed tasks contribute codes: a finished task's stale failure payload is ignored", () => {
    const result = sched(
      tcf("tcf", [{ kind: "parallel", children: [task("a"), task("b")] }], {
        catchChildren: [task("c")],
        catchErrors: ["E_BOOM"],
      }),
      { a: "failed", b: "finished", c: "pending" },
      descriptorMap(makeDescriptor("a"), makeDescriptor("b"), makeDescriptor("c")),
      // b succeeded on retry but a stale failure payload lingers; a failed with no code.
      { taskFailures: failures({ b: { code: "E_BOOM" } }) },
    );
    expect(result.runnable).toEqual([]);
    expect(result.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("codes are collected through nested sequence/group/parallel/ralph containers", () => {
    const plan = tcf(
      "tcf",
      [
        {
          kind: "sequence",
          children: [
            {
              kind: "group",
              children: [{ kind: "parallel", children: [task("deep")] }],
            },
            { kind: "ralph", id: "loop", until: true, children: [task("looped")] },
          ],
        },
      ],
      { catchChildren: [task("c")], catchErrors: ["E_LOOP"] },
    );
    const result = sched(
      plan,
      { deep: "finished", looped: "failed", c: "pending" },
      descriptorMap(makeDescriptor("deep"), makeDescriptor("looped"), makeDescriptor("c")),
      { taskFailures: failures({ looped: { code: "E_LOOP" } }) },
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.fatalError).toBeUndefined();
  });

  test("codes are collected from a nested saga's action and compensation children", () => {
    const saga = {
      kind: "saga",
      id: "s",
      onFailure: "compensate-and-fail",
      actionChildren: [task("sa"), task("sb")],
      compensationChildren: [task("ca"), task("cb")],
    };
    const result = sched(
      tcf("tcf", [saga], { catchChildren: [task("c")], catchErrors: ["E_COMP"] }),
      // Action sb failed (no recorded code); its compensation ca failed with the
      // code the filter matches — compensationChildren must be traversed too.
      { sa: "finished", sb: "failed", ca: "failed", cb: "finished", c: "pending" },
      descriptorMap(
        makeDescriptor("sa"),
        makeDescriptor("sb"),
        makeDescriptor("ca"),
        makeDescriptor("cb"),
        makeDescriptor("c"),
      ),
      { taskFailures: failures({ ca: { code: "E_COMP" } }) },
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.fatalError).toBeUndefined();
  });

  test("codes are collected from an inner try-catch-finally's try, catch, and finally regions", () => {
    const inner = tcf("inner", [task("it")], {
      catchChildren: [task("ic")],
      finallyChildren: [task("if")],
    });
    const stateObj = { it: "failed", ic: "failed", if: "failed", c: "pending" };
    const descriptors = descriptorMap(
      makeDescriptor("it"),
      makeDescriptor("ic"),
      makeDescriptor("if"),
      makeDescriptor("c"),
    );
    const taskFailures = failures({
      it: { code: "E_TRY" },
      ic: { code: "E_CATCH" },
      if: { code: "E_FIN" },
    });
    for (const code of ["E_TRY", "E_CATCH", "E_FIN"]) {
      const result = sched(
        tcf("outer", [inner], { catchChildren: [task("c")], catchErrors: [code] }),
        stateObj,
        descriptors,
        { taskFailures },
      );
      expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
      expect(result.fatalError).toBeUndefined();
    }
  });

  test("a try task with no registered descriptor is skipped without crashing the code scan", () => {
    const result = sched(
      tcf("tcf", [{ kind: "parallel", children: [task("ghost"), task("t")] }], {
        catchChildren: [task("c")],
        catchErrors: ["E_BOOM"],
      }),
      { t: "failed", c: "pending" },
      descriptorMap(makeDescriptor("t"), makeDescriptor("c")),
      { taskFailures: failures({ t: { code: "E_BOOM" } }) },
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["c"]);
    expect(result.fatalError).toBeUndefined();
  });
});
