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

function workflow(children) {
  return el("smithers:workflow", {}, children);
}

function graph(tasks, xml = workflow(tasks.map((task) => el("smithers:task", { id: task.nodeId })))) {
  return {
    xml,
    tasks,
    mountedTaskIds: new Set(tasks.map((task) => `${task.nodeId}::${task.iteration}`)),
  };
}

function run(effect) {
  return Effect.runSync(effect);
}

describe("WorkflowSessionService direct methods", () => {
  test("approval timeout applies the task timeout failure path", () => {
    const task = descriptor("approve", { needsApproval: true });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    const initial = run(session.submitGraph(graph([task])));
    expect(initial).toEqual({ _tag: "Wait", reason: { _tag: "Approval", nodeId: "approve" } });

    const decision = run(session.approvalTimedOut("approve"));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SESSION_ERROR");
    expect(decision.error.message).toContain("Task failed: approve");
  });

  test("eventReceived and signalReceived complete matching wait tasks", () => {
    const eventTask = descriptor("event", {
      meta: { __waitForEvent: true, __eventName: "ready", __correlationId: "c1" },
    });
    const signalTask = descriptor("signal", {
      meta: { __waitForEvent: true, __signalName: "kick", __correlationId: "c2" },
    });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph(
      [eventTask, signalTask],
      workflow([
        el("smithers:parallel", {}, [
          el("smithers:wait-for-event", { id: "event" }),
          el("smithers:wait-for-event", { id: "signal" }),
        ]),
      ]),
    )))._tag).toBe("Wait");

    const afterWrongCorrelation = run(session.eventReceived("ready", { ok: false }, "wrong"));
    expect(afterWrongCorrelation).toEqual({ _tag: "Wait", reason: { _tag: "Event", eventName: "ready" } });

    const afterEvent = run(session.eventReceived("ready", { ok: true }, "c1"));
    expect(afterEvent).toEqual({ _tag: "Wait", reason: { _tag: "Event", eventName: "" } });

    const afterSignal = run(session.signalReceived("kick", { done: true }, "c2"));
    expect(afterSignal._tag).toBe("Finished");
    expect(afterSignal.result.output).toEqual({ done: true });
  });

  test("timerFired records the fired timestamp and finishes timer tasks", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task], workflow([
      el("smithers:timer", { id: "timer" }),
    ]))))).toEqual({ _tag: "Wait", reason: { _tag: "Timer", resumeAtMs: 6_000 } });

    const decision = run(session.timerFired("timer", 7_000));
    expect(decision).toEqual({
      _tag: "Finished",
      result: {
        runId: expect.any(String),
        status: "finished",
        output: { firedAtMs: 7_000 },
      },
    });
  });

  test("hotReloaded cancels unmounted in-progress work and runs newly mounted tasks", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([descriptor("old")])))._tag).toBe("Execute");

    const next = graph([descriptor("next")]);
    const decision = run(session.hotReloaded(next));
    expect(decision._tag).toBe("Execute");
    expect(decision.tasks.map((task) => task.nodeId)).toEqual(["next"]);
    expect(run(session.getTaskStates()).get("old::0")).toBe("cancelled");
    expect(run(session.getCurrentGraph())).toBe(next);
  });

  test("heartbeatTimedOut can retry transient agent work", () => {
    const task = descriptor("agent", {
      agent: { id: "agent" },
      heartbeatTimeoutMs: 500,
      retries: 1,
      retryPolicy: { initialDelayMs: 250 },
    });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task])))._tag).toBe("Execute");

    const decision = run(session.heartbeatTimedOut("agent", 0, { workerId: "w1" }));
    expect(decision).toEqual({
      _tag: "Wait",
      reason: { _tag: "RetryBackoff", waitMs: 250 },
    });
  });

  test("cacheResolved completes a task and cacheMissed clears retry wait", () => {
    const task = descriptor("cached", {
      retries: 1,
      retryPolicy: { initialDelayMs: 500 },
    });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task])))._tag).toBe("Execute");
    expect(run(session.taskFailed({ nodeId: "cached", iteration: 0, error: { message: "miss" } }))).toEqual({
      _tag: "Wait",
      reason: { _tag: "RetryBackoff", waitMs: 500 },
    });

    const afterMiss = run(session.cacheMissed("cached", 0));
    expect(afterMiss._tag).toBe("Execute");

    const afterResolved = run(session.cacheResolved({
      nodeId: "cached",
      iteration: 0,
      output: { from: "cache" },
    }, true));
    expect(afterResolved._tag).toBe("Finished");
    expect(afterResolved.result.output).toEqual({ from: "cache" });
  });

  test("recoverOrphanedTasks requeues in-progress work and cancelRequested cancels active work", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const tasks = [
      descriptor("a", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      descriptor("b", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
    ];

    expect(run(session.submitGraph(graph(tasks, workflow([
      el("smithers:parallel", {}, [
        el("smithers:task", { id: "a" }),
        el("smithers:task", { id: "b" }),
      ]),
    ]))))).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "a" }] });

    const recovered = run(session.recoverOrphanedTasks());
    expect(recovered).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "a" }] });

    const cancelled = run(session.cancelRequested());
    expect(cancelled.result.status).toBe("cancelled");
    expect([...run(session.getTaskStates()).values()]).toEqual(["cancelled", "cancelled"]);
  });

  test("getSchedule exposes the latest computed scheduler snapshot", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.getSchedule())).toBeNull();
    run(session.submitGraph(graph([descriptor("only")])));

    const snapshot = run(session.getSchedule());
    expect(snapshot.computedAtMs).toBe(1_000);
    expect(snapshot.result.runnable.map((task) => task.nodeId)).toEqual(["only"]);
  });
});

describe("WorkflowSessionService decide branches", () => {
  test("explicit continue-as-new nodes return a continuation transition", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    const decision = run(session.submitGraph(graph([], workflow([
      el("smithers:continue-as-new", { stateJson: "{\"cursor\":\"abc\"}" }),
    ]))));

    expect(decision).toEqual({
      _tag: "ContinueAsNew",
      transition: { reason: "explicit", stateJson: "{\"cursor\":\"abc\"}" },
    });
  });

  test("completed ralph iterations advance and request rerender", () => {
    const task = descriptor("loop-task");
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task], workflow([
      el("smithers:ralph", { id: "loop", maxIterations: "3" }, [
        el("smithers:task", { id: "loop-task" }),
      ]),
    ]))))).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "loop-task" }] });

    const decision = run(session.taskCompleted({ nodeId: "loop-task", iteration: 0, output: "done" }));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.ralphIterations.get("loop")).toBe(1);
  });

  test("ralph continueAsNewEvery returns loop-threshold transitions at quiescence", () => {
    const task = descriptor("loop-task");
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    run(session.submitGraph(graph([task], workflow([
      el("smithers:ralph", { id: "loop", maxIterations: "3", continueAsNewEvery: "1" }, [
        el("smithers:task", { id: "loop-task" }),
      ]),
    ]))));

    const decision = run(session.taskCompleted({ nodeId: "loop-task", iteration: 0, output: "done" }));
    expect(decision).toEqual({
      _tag: "ContinueAsNew",
      transition: {
        reason: "loop-threshold",
        iteration: 1,
        statePayload: { ralphState: { loop: { iteration: 1, done: false } } },
      },
    });
  });

  test("ralph maxIterations fail policy returns RALPH_MAX_REACHED", () => {
    const task = descriptor("loop-task");
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    run(session.submitGraph(graph([task], workflow([
      el("smithers:ralph", { id: "loop", maxIterations: "1", onMaxReached: "fail" }, [
        el("smithers:task", { id: "loop-task" }),
      ]),
    ]))));

    const decision = run(session.taskCompleted({ nodeId: "loop-task", iteration: 0, output: "done" }));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("RALPH_MAX_REACHED");
  });

  test("aspect budget skip, warn, and fail branches are enforced before execution", () => {
    const skipped = [];
    const warned = [];
    const session = makeWorkflowSession({
      nowMs: () => 1_000,
      evaluateAspectBudget: (task) => {
        if (task.nodeId === "skip") {
          return { kind: "tokens", limit: 10, current: 10, onExceeded: "skip-remaining" };
        }
        if (task.nodeId === "warn") {
          return { kind: "tokens", limit: 10, current: 11, onExceeded: "warn" };
        }
        return { kind: "tokens", limit: 10, current: 12, onExceeded: "fail" };
      },
      onAspectBudgetSkip: (task) => skipped.push(task.nodeId),
      onAspectBudgetWarn: (task) => warned.push(task.nodeId),
    });

    const decision = run(session.submitGraph(graph(
      [descriptor("skip"), descriptor("warn"), descriptor("fail")],
      workflow([
        el("smithers:parallel", {}, [
          el("smithers:task", { id: "skip" }),
          el("smithers:task", { id: "warn" }),
          el("smithers:task", { id: "fail" }),
        ]),
      ]),
    )));

    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("ASPECT_BUDGET_EXCEEDED");
    expect(skipped).toEqual(["skip"]);
    expect(warned).toEqual(["warn"]);
    expect(run(session.getTaskStates()).get("warn::0")).toBe("in-progress");
    expect(run(session.getTaskStates()).get("skip::0")).toBe("skipped");
  });

  test("dependency deadlock explains only unsatisfied dependency edges", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const tasks = [
      descriptor("done"),
      descriptor("blocked", { dependsOn: ["done", "missing"] }),
    ];

    expect(run(session.submitGraph(graph(tasks, workflow([
      el("smithers:sequence", {}, [
        el("smithers:task", { id: "done" }),
        el("smithers:task", { id: "blocked" }),
      ]),
    ]))))).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "done" }] });

    const decision = run(session.taskCompleted({ nodeId: "done", iteration: 0, output: "ok" }));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("DEPENDENCY_DEADLOCK");
    expect(decision.error.message).toContain("'missing' (no such task)");
    expect(decision.error.message).not.toContain("'done' (finished)");
  });
});
