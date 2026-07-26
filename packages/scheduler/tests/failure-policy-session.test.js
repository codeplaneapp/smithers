import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function descriptor(nodeId, ordinal, overrides = {}) {
  return {
    nodeId,
    iteration: 0,
    ordinal,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    failurePolicy: "quarantine",
    parallelGroupId: "quarantine-parallel",
    parallelMaxConcurrency: 1,
    ...overrides,
  };
}

function graph(tasks) {
  return {
    xml: el("smithers:workflow", {}, [
      el(
        "smithers:parallel",
        { id: "quarantine-parallel", failurePolicy: "quarantine", maxConcurrency: "1" },
        tasks.map((task) => el("smithers:task", { id: task.nodeId })),
      ),
    ]),
    tasks,
    mountedTaskIds: new Set(tasks.map((task) => `${task.nodeId}::${task.iteration}`)),
  };
}

function run(effect) {
  return Effect.runSync(effect);
}

describe("makeWorkflowSession quarantine failure policy", () => {
  test("runs an independent sibling, cascade-skips dependents, and finishes successfully", () => {
    const failed = descriptor("F", 0);
    const sibling = descriptor("S", 1);
    const dependent = descriptor("D", 2, { dependsOn: ["F"] });
    const transitive = descriptor("T", 3, { dependsOn: ["D"] });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([failed, sibling, dependent, transitive])))).toEqual({
      _tag: "Execute",
      tasks: [failed],
    });

    const afterFailure = run(session.taskFailed({ nodeId: "F", iteration: 0, error: new Error("boom") }));
    expect(afterFailure).toEqual({ _tag: "Execute", tasks: [sibling] });
    expect(run(session.getTaskStates())).toEqual(
      new Map([
        ["F::0", "failed"],
        ["S::0", "in-progress"],
        ["D::0", "skipped"],
        ["T::0", "skipped"],
      ]),
    );

    const terminal = run(session.taskCompleted({ nodeId: "S", iteration: 0, output: "sibling finished" }));
    expect(terminal._tag).toBe("Finished");
    expect(terminal.result.status).toBe("finished");
    expect(terminal.result.failedChildKeys).toEqual(["F::0"]);
  });

  test("preserves continueOnFail dependency semantics inside quarantine", () => {
    const failed = descriptor("F", 0, { continueOnFail: true });
    const dependent = descriptor("D", 1, { dependsOn: ["F"] });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([failed, dependent])))).toEqual({
      _tag: "Execute",
      tasks: [failed],
    });
    expect(run(session.taskFailed({ nodeId: "F", iteration: 0, error: new Error("boom") }))).toEqual({
      _tag: "Execute",
      tasks: [dependent],
    });
  });
});
