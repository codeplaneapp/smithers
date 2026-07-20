import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
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

function graph(tasks, xml) {
  return {
    xml: xml ?? el("smithers:workflow", {}, tasks.map((task) => el("smithers:task", { id: task.nodeId }))),
    tasks,
    mountedTaskIds: new Set(tasks.map((task) => `${task.nodeId}::${task.iteration}`)),
  };
}

function run(effect) {
  return Effect.runSync(effect);
}

describe("makeWorkflowSession unknown-node error paths", () => {
  test("handlers return Failed decisions for unknown nodes (failedDecision)", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("a")])));

    expect(run(session.approvalResolved("nope", { approved: true }))._tag).toBe("Failed");
    expect(run(session.approvalTimedOut("nope"))._tag).toBe("Failed");
    expect(run(session.timerFired("nope"))._tag).toBe("Failed");
    expect(run(session.heartbeatTimedOut("nope", 0))._tag).toBe("Failed");
    expect(run(session.cacheResolved({ nodeId: "nope", iteration: 0, output: 1 }))._tag).toBe("Failed");
    expect(run(session.cacheMissed("nope", 0))._tag).toBe("Failed");
  });

  test("submitGraph reports a Failed decision when the plan build throws", () => {
    const nested = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "outer" }, [
        el("smithers:ralph", { id: "inner" }, []),
      ]),
    ]);
    const session = makeWorkflowSession();
    const decision = run(session.submitGraph({ xml: nested, tasks: [], mountedTaskIds: new Set() }));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SESSION_ERROR");
  });

  test("hotReloaded reports a Failed decision when the plan build throws", () => {
    const nested = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "outer" }, [
        el("smithers:ralph", { id: "inner" }, []),
      ]),
    ]);
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("a")])));
    const decision = run(session.hotReloaded({ xml: nested, tasks: [], mountedTaskIds: new Set() }));
    expect(decision._tag).toBe("Failed");
  });
});

describe("makeWorkflowSession decide branch coverage", () => {
  test("decide returns ExternalTrigger wait when no graph has been submitted", () => {
    const session = makeWorkflowSession();
    const decision = run(session.eventReceived("evt", 1));
    expect(decision).toEqual({ _tag: "Wait", reason: { _tag: "ExternalTrigger" } });
  });

  test("decide short-circuits to a cancelled result once the run is cancelled", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("a")])));
    run(session.cancelRequested());
    const decision = run(session.eventReceived("evt", 1));
    expect(decision._tag).toBe("Finished");
    expect(decision.result.status).toBe("cancelled");
  });

  test("approvalTimedOut on a non-waiting task re-decides instead of failing", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("appr", { needsApproval: true })])));
    run(session.approvalResolved("appr", { approved: true }));
    const decision = run(session.approvalTimedOut("appr"));
    expect(decision._tag).not.toBe("Failed");
  });

  test("timerFired on a non-waiting task re-decides instead of firing", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("a")])));
    const decision = run(session.timerFired("a"));
    expect(decision._tag).not.toBe("Failed");
  });
});

describe("makeWorkflowSession approval resolution branches", () => {
  test("denying with approvalOnDeny=skip marks the task skipped", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("appr", { needsApproval: true, approvalOnDeny: "skip" })])));
    const decision = run(session.approvalResolved("appr", { approved: false }));
    expect(decision._tag).toBe("Finished");
    const states = run(session.getTaskStates());
    expect(states.get("appr::0")).toBe("skipped");
  });

  test("denying with approvalOnDeny=continue finishes the task with the resolution output", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("appr", { needsApproval: true, approvalOnDeny: "continue" })])));
    const resolution = { approved: false, note: "carry on" };
    const decision = run(session.approvalResolved("appr", resolution));
    expect(decision._tag).toBe("Finished");
    const states = run(session.getTaskStates());
    expect(states.get("appr::0")).toBe("finished");
  });
});

describe("makeWorkflowSession timer scheduling", () => {
  test("a timer with an __timerUntil deadline parks in waiting-timer", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const timer = descriptor("t", {
      meta: { __timer: true, __timerUntil: "2999-01-01T00:00:00.000Z" },
    });
    const decision = run(session.submitGraph(graph([timer])));
    expect(decision._tag).toBe("Wait");
    expect(decision.reason._tag).toBe("Timer");
    expect(decision.reason.resumeAtMs).toBe(Date.parse("2999-01-01T00:00:00.000Z"));
  });

  test("a timer with an __timerDuration parks at start + duration", () => {
    const session = makeWorkflowSession({ nowMs: () => 5_000 });
    const timer = descriptor("t", {
      meta: { __timer: true, __timerDuration: "1h" },
    });
    const decision = run(session.submitGraph(graph([timer])));
    expect(decision._tag).toBe("Wait");
    expect(decision.reason._tag).toBe("Timer");
    expect(decision.reason.resumeAtMs).toBe(5_000 + 3_600_000);
  });
});

describe("makeWorkflowSession deadlock diagnostics", () => {
  test("mutually dependent pending tasks fail with a dependency deadlock", () => {
    const session = makeWorkflowSession();
    const a = descriptor("a", { dependsOn: ["b"] });
    const b = descriptor("b", { dependsOn: ["a"] });
    const decision = run(session.submitGraph(graph([a, b])));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("DEPENDENCY_DEADLOCK");
    expect(decision.error.message).toContain("(pending)");
  });

  test("requireStableFinish re-renders once before declaring a deadlock", () => {
    const session = makeWorkflowSession({ requireStableFinish: true });
    const a = descriptor("a", { dependsOn: ["b"] });
    const b = descriptor("b", { dependsOn: ["a"] });
    const decision = run(session.submitGraph(graph([a, b])));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.trigger.reason).toBe("deadlock-check");
  });
});

describe("makeWorkflowSession requireStableFinish success path", () => {
  test("a clean finish re-renders once for a stability check before finishing", () => {
    const session = makeWorkflowSession({ requireStableFinish: true });
    run(session.submitGraph(graph([descriptor("a")])));
    const decision = run(session.taskCompleted({ nodeId: "a", iteration: 0, output: 1 }));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.trigger.reason).toBe("stability-check");
  });
});

describe("makeWorkflowSession waiting reason accumulation", () => {
  test("an async approval falls through to the findWaitingReason approval branch", () => {
    const session = makeWorkflowSession();
    const decision = run(
      session.submitGraph(graph([descriptor("appr", { needsApproval: true, waitAsync: true })])),
    );
    expect(decision._tag).toBe("Wait");
    expect(decision.reason).toEqual({ _tag: "Approval", nodeId: "appr" });
  });
});

describe("makeWorkflowSession ralph loop advancement", () => {
  const ralphXml = (attrs) =>
    el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "loop", ...attrs }, [el("smithers:task", { id: "body" })]),
    ]);

  test("a completed ralph body advances the iteration with a loop-advanced re-render", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("body")], ralphXml({ maxIterations: "5" }))));
    const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.trigger.reason).toBe("loop-advanced");
  });

  test("reaching maxIterations with return-last marks the loop done", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("body")], ralphXml({ maxIterations: "1" }))));
    const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.trigger.reason).toBe("loop-advanced");
  });

  test("an until=true ralph is marked done at submission", () => {
    const session = makeWorkflowSession();
    const decision = run(
      session.submitGraph(graph([descriptor("body")], ralphXml({ until: "true" }))),
    );
    expect(decision._tag).toBe("Finished");
  });
});

describe("makeWorkflowSession saga fatal error surfacing", () => {
  test("a failed action in an onFailure=fail saga surfaces a scheduler error", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:saga", { id: "s", onFailure: "fail" }, [
        el("smithers:saga-actions", {}, [el("smithers:task", { id: "act" })]),
      ]),
    ]);
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("act")], xml)));
    const decision = run(
      session.taskFailed({ nodeId: "act", iteration: 0, error: new SmithersError("BOOM", "boom") }),
    );
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SCHEDULER_ERROR");
  });
});

describe("makeWorkflowSession timer parse failure", () => {
  test("a timer with neither until nor duration fails with INVALID_INPUT", () => {
    const session = makeWorkflowSession();
    const timer = descriptor("t", { meta: { __timer: true } });
    const decision = run(session.submitGraph(graph([timer])));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("INVALID_INPUT");
  });
});

describe("makeWorkflowSession pending-with-inflight and stable deadlock", () => {
  test("pending work alongside an in-flight task waits on an external trigger", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:parallel", {}, [
        el("smithers:task", { id: "inflight" }),
        el("smithers:task", { id: "blocked" }),
      ]),
    ]);
    const session = makeWorkflowSession();
    const first = run(
      session.submitGraph(
        graph([descriptor("inflight"), descriptor("blocked", { dependsOn: ["ghost"] })], xml),
      ),
    );
    expect(first._tag).toBe("Execute");
    const decision = run(session.eventReceived("x", 1));
    expect(decision).toEqual({ _tag: "Wait", reason: { _tag: "ExternalTrigger" } });
  });

  test("requireStableFinish fails a deadlock on the second pass with an unchanged graph", () => {
    const session = makeWorkflowSession({ requireStableFinish: true });
    const a = descriptor("a", { dependsOn: ["b"] });
    const b = descriptor("b", { dependsOn: ["a"] });
    const first = run(session.submitGraph(graph([a, b])));
    expect(first._tag).toBe("ReRender");
    const decision = run(session.eventReceived("x", 1));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("DEPENDENCY_DEADLOCK");
  });
});

describe("makeWorkflowSession continue-as-new deferral", () => {
  test("a ready continue-as-new ralph defers while a sibling task is still in flight", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:parallel", {}, [
        el("smithers:ralph", { id: "loop", continueAsNewEvery: "1", maxIterations: "5" }, [
          el("smithers:task", { id: "body" }),
        ]),
        el("smithers:task", { id: "other" }),
      ]),
    ]);
    const session = makeWorkflowSession();
    const first = run(session.submitGraph(graph([descriptor("body"), descriptor("other")], xml)));
    expect(first._tag).toBe("Execute");
    const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
    expect(decision).toEqual({ _tag: "Wait", reason: { _tag: "ExternalTrigger" } });
  });
});

describe("makeWorkflowSession initial timer starts", () => {
  test("initialTimerStarts keeps finite anchors and drops non-finite ones", () => {
    const session = makeWorkflowSession({
      initialTimerStarts: [
        ["a::0", 1000],
        ["a::0-bad", Number.NaN],
      ],
    });
    const decision = run(session.submitGraph(graph([descriptor("a")])));
    expect(decision._tag).toBe("Execute");
  });
});

describe("makeWorkflowSession explicit continue-as-new with timer anchors", () => {
  test("an explicit ContinueAsNew carries sorted mounted timer-start anchors", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:parallel", {}, [
        el("smithers:task", { id: "t1" }),
        el("smithers:task", { id: "t2" }),
        el("smithers:continue-as-new", { stateJson: '{"n":1}' }),
      ]),
    ]);
    const session = makeWorkflowSession({
      initialTimerStarts: [
        ["t2::0", 2000],
        ["t1::0", 1000],
      ],
    });
    const decision = run(session.submitGraph(graph([descriptor("t1"), descriptor("t2")], xml)));
    expect(decision._tag).toBe("ContinueAsNew");
    expect(decision.transition.reason).toBe("explicit");
    expect(decision.transition.stateJson).toBe('{"n":1}');
    expect(decision.transition.timerStarts).toEqual({ "t1::0": 1000, "t2::0": 2000 });
  });
});

describe("makeWorkflowSession continue-as-new emission", () => {
  test("a quiescent ready ralph at the threshold emits a loop-threshold continue-as-new", () => {
    const xml = el("smithers:workflow", {}, [
      el("smithers:ralph", { id: "loop", continueAsNewEvery: "1", maxIterations: "5" }, [
        el("smithers:task", { id: "body" }),
      ]),
    ]);
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("body")], xml)));
    const decision = run(session.taskCompleted({ nodeId: "body", iteration: 0, output: 1 }));
    expect(decision._tag).toBe("ContinueAsNew");
    expect(decision.transition.reason).toBe("loop-threshold");
    expect(decision.transition.iteration).toBe(1);
    expect(decision.transition.statePayload.ralphState.loop).toEqual({ iteration: 1, done: false });
  });
});

describe("makeWorkflowSession orphan recovery", () => {
  test("recoverOrphanedTasks returns OrphanRecovery when nothing is orphaned and the run waits", () => {
    const session = makeWorkflowSession();
    run(session.submitGraph(graph([descriptor("appr", { needsApproval: true })])));
    const decision = run(session.recoverOrphanedTasks());
    expect(decision._tag).toBe("Wait");
    expect(decision.reason).toEqual({ _tag: "OrphanRecovery", count: 0 });
  });
});
