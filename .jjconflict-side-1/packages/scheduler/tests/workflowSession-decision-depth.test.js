import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeDescriptor(nodeId, ordinal) {
  return {
    nodeId,
    iteration: 0,
    ordinal,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    skipIf: true,
  };
}

describe("makeWorkflowSession decision depth guard", () => {
  test("a long chain of sequential skipIf tasks finishes instead of tripping the depth guard", () => {
    // Regression: decide() recurses once per benign skip transition, and a
    // sequence yields one task per pass, so N skipIf tasks need N recursions. A
    // hard constant-10 guard turned any run with 11+ consecutive skipIf steps
    // (e.g. feature-flag-disabled steps) into a SCHEDULER_ERROR. The guard now
    // scales with the task count, so the run skips them all and finishes. 25
    // tasks proves the bound is task-proportional, not a bumped constant.
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptors = Array.from({ length: 25 }, (_, index) =>
      makeDescriptor(`skip-${index}`, index),
    );
    const graph = {
      xml: el(
        "smithers:workflow",
        {},
        descriptors.map((descriptor) =>
          el("smithers:task", { id: descriptor.nodeId }),
        ),
      ),
      tasks: descriptors,
      mountedTaskIds: new Set(
        descriptors.map((descriptor) => `${descriptor.nodeId}::0`),
      ),
    };

    const decision = Effect.runSync(session.submitGraph(graph));

    expect(decision._tag).toBe("Finished");
  });
});
