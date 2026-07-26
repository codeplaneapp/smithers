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

    expect(
      run(
        session.submitGraph(
          graph(
            [eventTask, signalTask],
            workflow([
              el("smithers:parallel", {}, [
                el("smithers:wait-for-event", { id: "event" }),
                el("smithers:wait-for-event", { id: "signal" }),
              ]),
            ]),
          ),
        ),
      )._tag,
    ).toBe("Wait");

    const afterWrongCorrelation = run(session.eventReceived("ready", { ok: false }, "wrong"));
    expect(afterWrongCorrelation).toEqual({ _tag: "Wait", reason: { _tag: "Event", eventName: "ready" } });

    const afterEvent = run(session.eventReceived("ready", { ok: true }, "c1"));
    expect(afterEvent).toEqual({ _tag: "Wait", reason: { _tag: "Event", eventName: "" } });

    const afterSignal = run(session.signalReceived("kick", { done: true }, "c2"));
    expect(afterSignal._tag).toBe("Finished");
    expect(afterSignal.result.output).toEqual({ done: true });
  });

  test("day-unit and uppercase durations resume at the deadline, not immediately", () => {
    // Regression: the scheduler's parser lacked `d` and was case-sensitive, so a
    // valid "1d"/"2H" timer parsed to null and fell through to "resume now",
    // firing immediately and re-deciding forever. It must match the engine
    // grammar (ms/s/m/h/d, case-insensitive).
    for (const [duration, expectedResumeAtMs] of [
      ["1d", 1_000 + 86_400_000],
      ["2H", 1_000 + 2 * 3_600_000],
      ["500MS", 1_000 + 500],
    ]) {
      const task = descriptor("timer", { meta: { __timer: true, __timerDuration: duration } });
      const session = makeWorkflowSession({ nowMs: () => 1_000 });
      expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
        _tag: "Wait",
        reason: { _tag: "Timer", resumeAtMs: expectedResumeAtMs },
      });
    }
  });

  test("timerFired records the fired timestamp and finishes timer tasks", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

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

  test("timerFired on a dependency-gated pending timer leaves it pending (#545)", () => {
    const upstream = descriptor("a");
    const timer = descriptor("timer", { dependsOn: ["a"], meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    const initial = run(
      session.submitGraph(
        graph([upstream, timer], workflow([el("smithers:task", { id: "a" }), el("smithers:timer", { id: "timer" })])),
      ),
    );
    expect(initial._tag).toBe("Execute");
    expect(initial.tasks.map((task) => task.nodeId)).toEqual(["a"]);

    // A premature engine reconcile (clock anchored before deps ran) must not
    // force-finish a timer whose dependencies are still unmet.
    const decision = run(session.timerFired("timer", 9_000));
    expect(decision._tag).not.toBe("Finished");
    expect(run(session.getTaskStates()).get("timer::0")).toBe("pending");
  });

  test("timerFired on an already-finished timer does not overwrite its output (#545)", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))._tag).toBe(
      "Wait",
    );
    expect(run(session.timerFired("timer", 6_000))._tag).toBe("Finished");

    const replay = run(session.timerFired("timer", 9_000));
    expect(replay).toMatchObject({
      _tag: "Finished",
      result: { output: { firedAtMs: 6_000 } },
    });
  });

  test("an unparseable timer duration fails loudly instead of firing immediately", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "soon" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    const decision = run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("INVALID_INPUT");
    expect(decision.error.details).toMatchObject({ nodeId: "timer", duration: "soon" });
  });

  test("timer duration parser accepts day units and is case-insensitive", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "2D" } });
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 1_000 + 2 * 86_400_000 },
    });
  });

  test("duration timer deadline is anchored at start and does not drift on re-decide", () => {
    let now = 1_000;
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => now });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

    // A later re-decide (a sibling completing, an unrelated event) must not push
    // the deadline out; it stays anchored at the 1_000 start + 5s = 6_000.
    now = 4_000;
    const afterReDecide = run(session.eventReceived("noop", { ignored: true }));
    expect(afterReDecide).toEqual({ _tag: "Wait", reason: { _tag: "Timer", resumeAtMs: 6_000 } });
  });

  test("timer wait outranks approval and event waits in both descriptor orders", () => {
    for (const blocker of [
      descriptor("approval", { needsApproval: true }),
      descriptor("event", { meta: { __waitForEvent: true, __eventName: "ready" } }),
    ]) {
      for (const timerFirst of [false, true]) {
        const timer = descriptor("timer", { meta: { __timer: true, __timerDuration: "2s" } });
        const tasks = timerFirst ? [timer, blocker] : [blocker, timer];
        const session = makeWorkflowSession({ nowMs: () => 1_000 });
        const xml = workflow([
          el(
            "smithers:parallel",
            {},
            tasks.map((task) =>
              el(
                task.meta?.__timer
                  ? "smithers:timer"
                  : task.meta?.__waitForEvent
                    ? "smithers:wait-for-event"
                    : "smithers:task",
                { id: task.nodeId },
              ),
            ),
          ),
        ]);

        expect(run(session.submitGraph(graph(tasks, xml)))).toEqual({
          _tag: "Wait",
          reason: { _tag: "Timer", resumeAtMs: 3_000 },
        });
        expect(run(session.eventReceived("unrelated", { ignored: true }))).toEqual({
          _tag: "Wait",
          reason: { _tag: "Timer", resumeAtMs: 3_000 },
        });
        let afterBlockerResolved;
        if (blocker.needsApproval) {
          const approved = run(session.approvalResolved("approval", { approved: true, note: "approved" }));
          expect(approved._tag).toBe("Execute");
          expect(approved.tasks.map((task) => task.nodeId)).toEqual(["approval"]);
          afterBlockerResolved = run(
            session.taskCompleted({
              nodeId: "approval",
              iteration: 0,
              output: { approved: true },
            }),
          );
        } else {
          afterBlockerResolved = run(session.signalReceived("ready", { ok: true }));
        }
        expect(afterBlockerResolved).toEqual({
          _tag: "Wait",
          reason: { _tag: "Timer", resumeAtMs: 3_000 },
        });
      }
    }
  });

  test("timer wait outranks a bound wait after the required bound-check render", () => {
    for (const timerFirst of [false, true]) {
      const bound = descriptor("bound", {
        proofBindingRequired: true,
        proofBindingStatus: "missing",
      });
      const timer = descriptor("timer", { meta: { __timer: true, __timerDuration: "2s" } });
      const tasks = timerFirst ? [timer, bound] : [bound, timer];
      const session = makeWorkflowSession({ nowMs: () => 1_000 });
      const xml = workflow([
        el(
          "smithers:parallel",
          {},
          tasks.map((task) => el(task.meta?.__timer ? "smithers:timer" : "smithers:task", { id: task.nodeId })),
        ),
      ]);
      const mounted = graph(tasks, xml);

      expect(run(session.submitGraph(mounted))).toMatchObject({
        _tag: "ReRender",
        context: { trigger: { reason: "bound-check" } },
      });
      expect(run(session.submitGraph(mounted))).toEqual({
        _tag: "Wait",
        reason: { _tag: "Timer", resumeAtMs: 3_000 },
      });
    }
  });

  test("parallel timers choose the earliest deadline in both descriptor orders", () => {
    for (const slowFirst of [true, false]) {
      const slow = descriptor("slow", { meta: { __timer: true, __timerDuration: "10s" } });
      const fast = descriptor("fast", { meta: { __timer: true, __timerDuration: "2s" } });
      const tasks = slowFirst ? [slow, fast] : [fast, slow];
      const session = makeWorkflowSession({ nowMs: () => 1_000 });
      const xml = workflow([
        el(
          "smithers:parallel",
          {},
          tasks.map((task) => el("smithers:timer", { id: task.nodeId })),
        ),
      ]);

      expect(run(session.submitGraph(graph(tasks, xml)))).toEqual({
        _tag: "Wait",
        reason: { _tag: "Timer", resumeAtMs: 3_000 },
      });
      expect(run(session.eventReceived("unrelated", { ignored: true }))).toEqual({
        _tag: "Wait",
        reason: { _tag: "Timer", resumeAtMs: 3_000 },
      });
    }
  });

  test("duration timer start is carried in continuation state", () => {
    let now = 1_000;
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({ nowMs: () => now });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

    const decision = run(
      session.submitGraph(
        graph(
          [task],
          workflow([
            el("smithers:parallel", {}, [el("smithers:timer", { id: "timer" }), el("smithers:continue-as-new", {})]),
          ]),
        ),
      ),
    );

    expect(decision).toMatchObject({
      _tag: "ContinueAsNew",
      transition: {
        reason: "explicit",
        timerStarts: { "timer::0": 1_000 },
      },
    });
    // The anchor lives on the dedicated `timerStarts` field, not inside the
    // user-visible `statePayload`, so an explicit continue-as-new state cannot
    // clobber it.
    expect(decision.transition.statePayload).toBeUndefined();

    now = 4_000;
    const nextSession = makeWorkflowSession({
      nowMs: () => now,
      initialTimerStarts: new Map(Object.entries(decision.transition.timerStarts)),
    });

    expect(run(nextSession.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });
  });

  test("a carried timer anchor whose key never re-mounts is dropped from the next continuation", () => {
    // Regression: timerStartsField() dumped the entire timerStarts map, so a
    // stale anchor carried across a continue-as-new boundary whose state key
    // never re-mounts in the child (an iteration-shifted or conditionally
    // unmounted timer) re-carried forever. Only currently-mounted timer keys
    // may be emitted.
    const now = 1_000;
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({
      nowMs: () => now,
      // "gone::0" is a dead anchor from a prior generation that will not mount
      // in the graph below; only "timer::0" is live.
      initialTimerStarts: new Map([["gone::0", 500]]),
    });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

    const decision = run(
      session.submitGraph(
        graph(
          [task],
          workflow([
            el("smithers:parallel", {}, [el("smithers:timer", { id: "timer" }), el("smithers:continue-as-new", {})]),
          ]),
        ),
      ),
    );

    expect(decision).toMatchObject({
      _tag: "ContinueAsNew",
      transition: { timerStarts: { "timer::0": 1_000 } },
    });
    // The stale "gone::0" anchor must NOT be re-carried into the continuation.
    expect(decision.transition.timerStarts).not.toHaveProperty("gone::0");
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

    const afterResolved = run(
      session.cacheResolved(
        {
          nodeId: "cached",
          iteration: 0,
          output: { from: "cache" },
        },
        true,
      ),
    );
    expect(afterResolved._tag).toBe("Finished");
    expect(afterResolved.result.output).toEqual({ from: "cache" });
  });

  test("rerender decisions carry trigger reasons for task and cache completions", () => {
    const task = descriptor("fast");
    const cachedTask = descriptor("cached");
    const session = makeWorkflowSession({
      nowMs: () => 1_000,
      requireRerenderOnOutputChange: true,
    });

    expect(run(session.submitGraph(graph([task, cachedTask])))._tag).toBe("Execute");

    const completed = run(
      session.taskCompleted({
        nodeId: "fast",
        iteration: 0,
        output: { ok: true },
      }),
    );
    expect(completed).toMatchObject({
      _tag: "ReRender",
      context: {
        trigger: { reason: "task-finished", nodeId: "fast", iteration: 0 },
      },
    });

    run(session.submitGraph(graph([cachedTask])));
    const cached = run(
      session.cacheResolved(
        {
          nodeId: "cached",
          iteration: 0,
          output: { ok: "cached" },
        },
        true,
      ),
    );
    expect(cached).toMatchObject({
      _tag: "ReRender",
      context: {
        trigger: { reason: "cache-resolved", nodeId: "cached", iteration: 0 },
      },
    });
  });

  test("rerender decisions carry timer-fired trigger reasons", () => {
    const task = descriptor("timer", { meta: { __timer: true, __timerDuration: "5s" } });
    const session = makeWorkflowSession({
      nowMs: () => 1_000,
      requireRerenderOnOutputChange: true,
    });

    expect(run(session.submitGraph(graph([task], workflow([el("smithers:timer", { id: "timer" })]))))).toEqual({
      _tag: "Wait",
      reason: { _tag: "Timer", resumeAtMs: 6_000 },
    });

    const decision = run(session.timerFired("timer", 7_000));
    expect(decision).toMatchObject({
      _tag: "ReRender",
      context: {
        trigger: { reason: "timer-fired", nodeId: "timer", iteration: 0 },
      },
    });
  });

  test("recoverOrphanedTasks requeues in-progress work and cancelRequested cancels active work", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const tasks = [
      descriptor("a", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
      descriptor("b", { parallelGroupId: "g", parallelMaxConcurrency: 1 }),
    ];

    expect(
      run(
        session.submitGraph(
          graph(
            tasks,
            workflow([
              el("smithers:parallel", {}, [el("smithers:task", { id: "a" }), el("smithers:task", { id: "b" })]),
            ]),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "a" }] });

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

    const decision = run(
      session.submitGraph(graph([], workflow([el("smithers:continue-as-new", { stateJson: '{"cursor":"abc"}' })]))),
    );

    expect(decision).toEqual({
      _tag: "ContinueAsNew",
      transition: { reason: "explicit", stateJson: '{"cursor":"abc"}' },
    });
  });

  test("completed ralph iterations advance and request rerender", () => {
    const task = descriptor("loop-task");
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    expect(
      run(
        session.submitGraph(
          graph(
            [task],
            workflow([
              el("smithers:ralph", { id: "loop", maxIterations: "3" }, [el("smithers:task", { id: "loop-task" })]),
            ]),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "loop-task" }] });

    const decision = run(session.taskCompleted({ nodeId: "loop-task", iteration: 0, output: "done" }));
    expect(decision._tag).toBe("ReRender");
    expect(decision.context.ralphIterations.get("loop")).toBe(1);
  });

  test("ralph continueAsNewEvery returns loop-threshold transitions at quiescence", () => {
    const task = descriptor("loop-task");
    const session = makeWorkflowSession({ nowMs: () => 1_000 });

    run(
      session.submitGraph(
        graph(
          [task],
          workflow([
            el("smithers:ralph", { id: "loop", maxIterations: "3", continueAsNewEvery: "1" }, [
              el("smithers:task", { id: "loop-task" }),
            ]),
          ]),
        ),
      ),
    );

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

    run(
      session.submitGraph(
        graph(
          [task],
          workflow([
            el("smithers:ralph", { id: "loop", maxIterations: "1", onMaxReached: "fail" }, [
              el("smithers:task", { id: "loop-task" }),
            ]),
          ]),
        ),
      ),
    );

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

    const decision = run(
      session.submitGraph(
        graph(
          [descriptor("skip"), descriptor("warn"), descriptor("fail")],
          workflow([
            el("smithers:parallel", {}, [
              el("smithers:task", { id: "skip" }),
              el("smithers:task", { id: "warn" }),
              el("smithers:task", { id: "fail" }),
            ]),
          ]),
        ),
      ),
    );

    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("ASPECT_BUDGET_EXCEEDED");
    expect(skipped).toEqual(["skip"]);
    expect(warned).toEqual(["warn"]);
    expect(run(session.getTaskStates()).get("warn::0")).toBe("in-progress");
    expect(run(session.getTaskStates()).get("skip::0")).toBe("skipped");
  });

  test("dependency deadlock explains only unsatisfied dependency edges", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const tasks = [descriptor("done"), descriptor("blocked", { dependsOn: ["done", "missing"] })];

    expect(
      run(
        session.submitGraph(
          graph(
            tasks,
            workflow([
              el("smithers:sequence", {}, [
                el("smithers:task", { id: "done" }),
                el("smithers:task", { id: "blocked" }),
              ]),
            ]),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "Execute", tasks: [{ nodeId: "done" }] });

    const decision = run(session.taskCompleted({ nodeId: "done", iteration: 0, output: "ok" }));
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("DEPENDENCY_DEADLOCK");
    expect(decision.error.message).toContain("'missing' (no such task)");
    expect(decision.error.message).not.toContain("'done' (finished)");
  });
});
