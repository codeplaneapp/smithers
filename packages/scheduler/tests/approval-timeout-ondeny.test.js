import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function descriptor(nodeId, overrides = {}) {
  return {
    nodeId,
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    ...overrides,
  };
}

function graph(tasks) {
  return {
    xml: el(
      "smithers:workflow",
      {},
      tasks.map((task) => el("smithers:task", { id: task.nodeId })),
    ),
    tasks,
    mountedTaskIds: new Set(tasks.map((task) => `${task.nodeId}::${task.iteration}`)),
  };
}

function run(effect) {
  return Effect.runSync(effect);
}

// Timeout auto-deny must honor the task's onDeny policy, not unconditionally
// fail the run: a timed-out gate with onDeny=skip/continue is a tolerated
// denial, and only the default (fail) policy carries the TASK_TIMEOUT failure.
describe("approvalTimedOut honors approvalOnDeny", () => {
  test("onDeny=skip: a timed-out approval skips the task and finishes the run", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("gate", { needsApproval: true, approvalOnDeny: "skip" })])));

    const decision = run(session.approvalTimedOut("gate"));
    expect(decision._tag).toBe("Finished");
    expect(decision.result.status).toBe("finished");
    const states = run(session.getTaskStates());
    expect(states.get("gate::0")).toBe("skipped");
  });

  test("onDeny=continue: a timed-out approval finishes the task with the auto-deny resolution as output", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("gate", { needsApproval: true, approvalOnDeny: "continue" })])));

    const decision = run(session.approvalTimedOut("gate"));
    expect(decision._tag).toBe("Finished");
    expect(decision.result.status).toBe("finished");
    expect(decision.result.output).toEqual({ approved: false, note: "approval timed out" });
    const states = run(session.getTaskStates());
    expect(states.get("gate::0")).toBe("finished");
  });

  test("default onDeny (fail): a timed-out approval fails the run with TASK_TIMEOUT context", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("gate", { needsApproval: true })])));

    const decision = run(session.approvalTimedOut("gate"));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.message).toContain("gate");
    const states = run(session.getTaskStates());
    expect(states.get("gate::0")).toBe("failed");
  });

  test("an explicit denial with default onDeny fails the task with the operator resolution", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("gate", { needsApproval: true })])));

    const decision = run(session.approvalResolved("gate", { approved: false, note: "not today" }));
    expect(decision._tag).toBe("Failed");
    const states = run(session.getTaskStates());
    expect(states.get("gate::0")).toBe("failed");
  });
});
