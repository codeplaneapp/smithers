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
    driver.inflightTaskDescriptors = new Map([
      ["k", { nodeId: "a", iteration: 0 }],
    ]);

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
    driver.inflightTaskDescriptors = new Map([
      ["k", { nodeId: "a", iteration: 0 }],
    ]);

    const result = await driver.nextCompletionDecision(15);
    expect(result).toEqual({ runId: "r1", status: "waiting-event" });
  });
});
