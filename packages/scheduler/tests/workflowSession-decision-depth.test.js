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
  test("surfaces runaway internal decision loops instead of waiting silently", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptors = Array.from({ length: 11 }, (_, index) =>
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

    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SCHEDULER_ERROR");
    expect(decision.error.message).toContain("Exceeded scheduler decide() depth");
  });
});
