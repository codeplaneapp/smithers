import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeTaskDescriptor(nodeId, iteration = 0) {
  return {
    nodeId,
    iteration,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    meta: {},
  };
}

function makeGraph(descriptors) {
  return {
    xml: el(
      "smithers:workflow",
      {},
      descriptors.map((d) => el("smithers:task", { id: d.nodeId })),
    ),
    tasks: descriptors,
    mountedTaskIds: new Set(descriptors.map((d) => `${d.nodeId}::${d.iteration}`)),
  };
}

// Regression: a conditionally-rendered task ({done ? <Task pr/> : null}) can complete
// AFTER its parent re-rendered it out of the graph. The completion/failure then names a
// task whose descriptor is gone. The session must treat that as a stale (no-op) result,
// NOT fail the whole run — otherwise every other in-flight task is discarded. (Observed
// as `SESSION_ERROR: taskCompleted: Unknown task <id>` killing a fan-out run mid-flight.)
describe("makeWorkflowSession tolerates stale completions for tasks no longer in the graph", () => {
  test("taskCompleted for a node no longer in the graph does not fail the run", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    Effect.runSync(session.submitGraph(makeGraph([makeTaskDescriptor("live-task")])));

    const decision = Effect.runSync(
      session.taskCompleted({
        nodeId: "gone-pr-task",
        iteration: 0,
        output: { ok: true },
      }),
    );

    expect(decision._tag).not.toBe("Failed");
  });

  test("taskFailed for a node no longer in the graph does not fail the run", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    Effect.runSync(session.submitGraph(makeGraph([makeTaskDescriptor("live-task")])));

    const decision = Effect.runSync(
      session.taskFailed({
        nodeId: "gone-task",
        iteration: 0,
        error: new Error("boom"),
      }),
    );

    expect(decision._tag).not.toBe("Failed");
  });
});
