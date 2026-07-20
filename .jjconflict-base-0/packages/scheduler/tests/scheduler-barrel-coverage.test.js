import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  buildPlanTree,
  buildStateKey,
  cloneTaskStateMap,
  computeRetryDelayMs,
  isTerminalState,
  makeWorkflowSession,
  nowMs,
  parseStateKey,
  retryPolicyToSchedule,
  retryScheduleDelayMs,
  Scheduler,
  SchedulerLive,
  scheduleTasks,
  WorkflowSession,
  WorkflowSessionLive,
} from "../src/index.js";

describe("scheduler package barrel", () => {
  test("re-exports the concrete functions", () => {
    expect(typeof buildPlanTree).toBe("function");
    expect(typeof buildStateKey).toBe("function");
    expect(typeof cloneTaskStateMap).toBe("function");
    expect(typeof computeRetryDelayMs).toBe("function");
    expect(typeof isTerminalState).toBe("function");
    expect(typeof makeWorkflowSession).toBe("function");
    expect(typeof parseStateKey).toBe("function");
    expect(typeof retryPolicyToSchedule).toBe("function");
    expect(typeof retryScheduleDelayMs).toBe("function");
    expect(typeof scheduleTasks).toBe("function");
  });

  test("the Scheduler and WorkflowSession context tags carry their keys and instantiate", () => {
    expect(Scheduler.key).toBe("Scheduler");
    expect(WorkflowSession.key).toBe("WorkflowSession");
    expect(new Scheduler()).toBeInstanceOf(Scheduler);
    expect(new WorkflowSession()).toBeInstanceOf(WorkflowSession);
  });

  test("nowMs returns the current epoch milliseconds", () => {
    const before = Date.now();
    const value = nowMs();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  test("SchedulerLive layer provides a Scheduler that delegates to scheduleTasks", () => {
    const program = Effect.gen(function* () {
      const scheduler = yield* Scheduler;
      return yield* scheduler.schedule(
        null,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        0,
      );
    });
    const result = Effect.runSync(Effect.provide(program, SchedulerLive));
    expect(result.runnable).toEqual([]);
    expect(result.pendingExists).toBe(false);
  });

  test("WorkflowSessionLive layer yields a live workflow session", () => {
    const program = Effect.gen(function* () {
      const session = yield* WorkflowSession;
      return session;
    });
    const session = Effect.runSync(Effect.provide(program, WorkflowSessionLive));
    expect(typeof session.submitGraph).toBe("function");
    expect(typeof session.taskCompleted).toBe("function");
  });
});
