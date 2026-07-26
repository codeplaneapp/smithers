import { describe, expect, test } from "bun:test";
import { WorkflowDriver } from "../src/WorkflowDriver.js";

/**
 * `handleWait` with a `RetryBackoff` reason and no in-flight work sleeps for the
 * backoff window via the internal `sleepWithAbort` helper, then asks the session
 * for the next decision. This is the only path that drives `sleepWithAbort` with
 * a positive delay and a non-aborted signal, so it covers the timer-arming
 * branch of that helper.
 */
describe("WorkflowDriver.handleWait — RetryBackoff", () => {
  test("sleeps the backoff window then requests the next decision", async () => {
    let asked = false;
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {
        getNextDecision: () => {
          asked = true;
          return { runId: "r1", status: "finished" };
        },
      },
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {} };

    const start = performance.now();
    const result = await driver.handleWait({ _tag: "RetryBackoff", waitMs: 20 });
    const elapsed = performance.now() - start;

    expect(result).toEqual({ runId: "r1", status: "finished" });
    expect(asked).toBe(true);
    // The backoff timer actually fired (allow slack for timer coarseness).
    expect(elapsed).toBeGreaterThanOrEqual(10);
  });

  test("falls back to re-submitting the last graph when the session has no getNextDecision", async () => {
    let submitted = null;
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {
        submitGraph: (graph) => {
          submitted = graph;
          return { runId: "r1", status: "waiting-timer" };
        },
      },
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {} };
    driver.lastGraph = { nodes: [] };

    const result = await driver.handleWait({ _tag: "RetryBackoff", waitMs: 5 });

    expect(submitted).toEqual({ nodes: [] });
    expect(result).toEqual({ runId: "r1", status: "waiting-timer" });
  });

  test("cancels the run when aborted during the backoff", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {
        cancelRequested: () => {
          cancellations += 1;
          return { runId: "r1", status: "cancelled" };
        },
      },
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {}, signal: controller.signal };

    const resultPromise = driver.handleWait({
      _tag: "RetryBackoff",
      waitMs: 60_000,
    });
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      runId: "r1",
      status: "cancelled",
    });
    expect(cancellations).toBe(1);
  });
});

describe("WorkflowDriver.nextCompletionDecision — deadline racer", () => {
  test("deadline elapses before any in-flight task settles and re-submits the last graph", async () => {
    let submitted = null;
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {
        submitGraph: (graph) => {
          submitted = graph;
          return { runId: "r1", status: "waiting-timer" };
        },
      },
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {} };
    driver.lastGraph = { nodes: [] };
    // One in-flight task that never settles, so the deadline sleep wins the
    // race and its `.then(() => null)` continuation fires.
    driver.inflightTasks = new Map([["k", new Promise(() => {})]]);
    driver.inflightTaskDescriptors = new Map([["k", { nodeId: "a", iteration: 0 }]]);

    const result = await driver.nextCompletionDecision(15);

    expect(submitted).toEqual({ nodes: [] });
    expect(result).toEqual({ runId: "r1", status: "waiting-timer" });
  });

  test("deadline elapses with no last graph reports waiting-event", async () => {
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {},
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {} };
    driver.inflightTasks = new Map([["k", new Promise(() => {})]]);
    driver.inflightTaskDescriptors = new Map([["k", { nodeId: "a", iteration: 0 }]]);

    const result = await driver.nextCompletionDecision(15);
    expect(result).toEqual({ runId: "r1", status: "waiting-event" });
  });

  test("tears the deadline down when a completion wins the race", async () => {
    // `Promise.race` does not cancel its losers, so a long deadline that loses
    // to a real completion used to leak both its timer and its `'abort'`
    // listener on the run signal for the full window — one fresh pair per
    // completion, since `handleWait` re-enters here while tasks stay in flight.
    const controller = new AbortController();
    const { signal } = controller;
    let added = 0;
    let removed = 0;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, ...rest) => {
      if (type === "abort") added += 1;
      return realAdd(type, ...rest);
    };
    signal.removeEventListener = (type, ...rest) => {
      if (type === "abort") removed += 1;
      return realRemove(type, ...rest);
    };

    /** Timers armed during the wait that neither fired nor were cleared. */
    const pending = new Set();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      let id;
      id = realSetTimeout(
        (...args) => {
          pending.delete(id);
          return fn?.(...args);
        },
        ms,
        ...rest,
      );
      pending.add(id);
      return id;
    };
    globalThis.clearTimeout = (id) => {
      pending.delete(id);
      return realClearTimeout(id);
    };

    try {
      const driver = new WorkflowDriver({
        workflow: { db: {} },
        db: {},
        runtime: { runPromise: async (value) => value },
        executeTask: () => new Promise((resolve) => realSetTimeout(() => resolve({ ok: true }), 5)),
        session: {
          taskCompleted: () => ({ _tag: "Execute", tasks: [] }),
        },
      });
      driver.activeRunId = "r1";
      driver.activeOptions = { input: {}, signal };
      driver.startInflightTask({ nodeId: "a", iteration: 0 }, { runId: "r1", options: driver.activeOptions, signal });

      const result = await driver.nextCompletionDecision(300_000);

      expect(result).toEqual({ _tag: "Execute", tasks: [] });
      // Every listener the wait installed was detached again.
      expect(removed).toBe(added);
      // No ~5-minute deadline timer left holding the event loop open.
      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("cancels the run when aborted during the deadline wait", async () => {
    const controller = new AbortController();
    let cancellations = 0;
    const driver = new WorkflowDriver({
      workflow: { db: {} },
      db: {},
      runtime: { runPromise: async (value) => value },
      session: {
        cancelRequested: () => {
          cancellations += 1;
          return { runId: "r1", status: "cancelled" };
        },
      },
    });
    driver.activeRunId = "r1";
    driver.activeOptions = { input: {}, signal: controller.signal };
    driver.inflightTasks = new Map([["k", new Promise(() => {})]]);
    driver.inflightTaskDescriptors = new Map([["k", { nodeId: "a", iteration: 0 }]]);

    const resultPromise = driver.nextCompletionDecision(60_000);
    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      runId: "r1",
      status: "cancelled",
    });
    expect(cancellations).toBe(1);
  });
});
