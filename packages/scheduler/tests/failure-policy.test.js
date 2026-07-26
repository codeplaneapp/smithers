import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";
import { scheduleTasks } from "../src/scheduleTasks.js";

function descriptor(nodeId, overrides = {}) {
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

function schedule(plan, descs, states) {
  return scheduleTasks(
    plan,
    new Map(states),
    new Map(descs.map((d) => [d.nodeId, d])),
    new Map(),
    new Map(),
    0,
  ).runnable.map((d) => d.nodeId);
}

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function graph(descriptors, containerTag = "smithers:sequence") {
  return {
    xml: el("smithers:workflow", {}, [
      el(
        containerTag,
        {},
        descriptors.map((d) => el("smithers:task", { id: d.nodeId })),
      ),
    ]),
    tasks: descriptors,
    mountedTaskIds: new Set(descriptors.map((d) => `${d.nodeId}::${d.iteration}`)),
  };
}

describe("container failurePolicy quarantine traversal", () => {
  test("quarantine advances independent siblings but keeps direct and transitive dependents gated", () => {
    const failed = descriptor("F", { failurePolicy: "quarantine" });
    const sibling = descriptor("S");
    const dependent = descriptor("D", { dependsOn: ["F"] });
    const transitive = descriptor("T", { dependsOn: ["D"] });
    const plan = { kind: "sequence", children: ["F", "S", "D", "T"].map((nodeId) => ({ kind: "task", nodeId })) };
    expect(schedule(plan, [failed, sibling, dependent, transitive], [["F::0", "failed"]])).toEqual(["S"]);
    const parallelPlan = {
      kind: "parallel",
      children: ["F", "S", "D", "T"].map((nodeId) => ({ kind: "task", nodeId })),
    };
    expect(schedule(parallelPlan, [failed, sibling, dependent, transitive], [["F::0", "failed"]])).toEqual(["S"]);
  });

  test("halt and omitted policy preserve the existing sequence stop", () => {
    for (const failurePolicy of [undefined, "halt"]) {
      const failed = descriptor("F", failurePolicy ? { failurePolicy } : {});
      const sibling = descriptor("S");
      const dependent = descriptor("D", { dependsOn: ["F"] });
      const plan = { kind: "sequence", children: ["F", "S", "D"].map((nodeId) => ({ kind: "task", nodeId })) };
      expect(schedule(plan, [failed, sibling, dependent], [["F::0", "failed"]])).toEqual([]);
    }
  });

  test("quarantine completes a failed parallel before an enclosing sequence sibling", () => {
    const failed = descriptor("F", { failurePolicy: "quarantine" });
    const sibling = descriptor("S");
    const plan = {
      kind: "sequence",
      children: [
        { kind: "parallel", children: [{ kind: "task", nodeId: "F" }] },
        { kind: "task", nodeId: "S" },
      ],
    };
    expect(schedule(plan, [failed, sibling], [["F::0", "failed"]])).toEqual(["S"]);
  });

  test("session executes an independent sibling after quarantine and never its direct or transitive dependents", () => {
    const failed = descriptor("F", { failurePolicy: "quarantine", retries: 0 });
    const sibling = descriptor("S", { retries: 0 });
    const dependent = descriptor("D", { dependsOn: ["F"], retries: 0 });
    const transitive = descriptor("T", { dependsOn: ["D"], retries: 0 });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    expect(Effect.runSync(session.submitGraph(graph([failed, sibling, dependent, transitive])))._tag).toBe("Execute");
    expect(Effect.runSync(session.taskFailed({ nodeId: "F", iteration: 0, error: new Error("boom") }))).toEqual({
      _tag: "Execute",
      tasks: [sibling],
    });
    const finished = Effect.runSync(session.taskCompleted({ nodeId: "S", iteration: 0, output: "ok" }));
    expect(finished._tag).toBe("Finished");
    expect(finished.result.failedChildKeys).toEqual(["F::0"]);
  });

  test("quarantine also lets an enclosing sequence continue past a failed parallel", () => {
    const failed = descriptor("F", { failurePolicy: "quarantine", retries: 0 });
    const sibling = descriptor("S", { retries: 0 });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const nestedGraph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:sequence", {}, [
          el("smithers:parallel", {}, [el("smithers:task", { id: "F" })]),
          el("smithers:task", { id: "S" }),
        ]),
      ]),
      tasks: [failed, sibling],
      mountedTaskIds: new Set(["F::0", "S::0"]),
    };
    const decision = Effect.runSync(session.submitGraph(nestedGraph));
    expect(decision._tag).toBe("Execute");
    expect(Effect.runSync(session.taskFailed({ nodeId: "F", iteration: 0, error: new Error("boom") }))).toEqual({
      _tag: "Execute",
      tasks: [sibling],
    });
  });

  test("halt remains a session-level failure", () => {
    const failed = descriptor("F", { retries: 0 });
    const sibling = descriptor("S", { retries: 0 });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    Effect.runSync(session.submitGraph(graph([failed, sibling])));
    const decision = Effect.runSync(session.taskFailed({ nodeId: "F", iteration: 0, error: new Error("boom") }));
    expect(decision._tag).toBe("Failed");
  });
});
