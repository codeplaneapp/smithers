import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import {
  __workflowMakeBridgeInternals as I,
  createSchedulerWakeQueue,
  getWorkflowMakeBridgeRuntime,
  runWorkflowWithMakeBridge,
  withWorkflowMakeBridgeRuntime,
} from "../src/effect/workflow-make-bridge.js";

describe("workflow make bridge internals", () => {
  test("namespaces workflows and classifies suspending statuses", async () => {
    const workflowA = {};
    const workflowB = {};
    const namespaceA = I.getWorkflowNamespace(workflowA);
    const namespaceB = I.getWorkflowNamespace(workflowB);
    const bridgeA = I.makeBridgeWorkflow(workflowA, "run");
    expect(namespaceA).toBe(I.getWorkflowNamespace(workflowA));
    expect(namespaceA).not.toBe(namespaceB);
    expect(bridgeA._tag).toBe(`SmithersWorkflowBridge:${namespaceA}:run`);
    expect(I.makeBridgeWorkflow(workflowA, "run")._tag).toBe(bridgeA._tag);
    expect(I.makeBridgeWorkflow(workflowA, "other-run")._tag).not.toBe(bridgeA._tag);
    expect(I.makeBridgeWorkflow(workflowB, "run")._tag).not.toBe(bridgeA._tag);
    expect(bridgeA.idempotencyKey({ executionId: "execution" })).toBe("execution");
    const executionId = await Effect.runPromise(bridgeA.executionId({ executionId: "execution" }));
    expect(await Effect.runPromise(bridgeA.executionId({ executionId: "execution" }))).toBe(executionId);
    expect(
      await Effect.runPromise(I.makeBridgeWorkflow(workflowA, "other-run").executionId({ executionId: "execution" })),
    ).not.toBe(executionId);
    expect(I.isSuspendingStatus("waiting-approval")).toBe(true);
    expect(I.isSuspendingStatus("waiting-event")).toBe(true);
    expect(I.isSuspendingStatus("waiting-timer")).toBe(true);
    expect(I.isSuspendingStatus("finished")).toBe(false);
    expect(I.statusAfterWorkflowSuspended("running")).toBe("paused");
    expect(I.statusAfterWorkflowSuspended(undefined)).toBe("paused");
    expect(I.statusAfterWorkflowSuspended("waiting-event")).toBe("waiting-event");
    expect(I.statusAfterWorkflowSuspended("failed")).toBe("failed");
  });

  test("scopes workflow make bridge runtime in async local storage", () => {
    const runtime = { marker: "runtime" };
    expect(getWorkflowMakeBridgeRuntime()).toBeUndefined();
    expect(withWorkflowMakeBridgeRuntime(runtime, () => getWorkflowMakeBridgeRuntime())).toBe(runtime);
    expect(getWorkflowMakeBridgeRuntime()).toBeUndefined();
  });

  test("scheduler wake queue handles pending and future notifications", async () => {
    const queue = createSchedulerWakeQueue();
    queue.notify();
    await queue.wait();

    let resolved = false;
    const waiting = queue.wait().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    queue.notify();
    await waiting;
    expect(resolved).toBe(true);
  });

  test("continues workflow execution with the next run id", async () => {
    const { db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const workflow = { db };
      const calls = [];
      const result = await runWorkflowWithMakeBridge(workflow, { runId: "first-run" }, async (_workflow, opts) => {
        calls.push(opts);
        if (calls.length === 1) {
          return {
            runId: opts.runId,
            status: "continued",
            nextRunId: "second-run",
          };
        }
        return {
          runId: opts.runId,
          status: "finished",
        };
      });
      expect(result).toEqual({
        runId: "second-run",
        status: "finished",
      });
      expect(calls).toEqual([
        expect.objectContaining({ runId: "first-run" }),
        expect.objectContaining({ runId: "second-run", resume: true }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("executes registered child workflows under the parent bridge", async () => {
    const { db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const parentWorkflow = { db };
      const childWorkflow = { db };
      const calls = [];
      const result = await runWorkflowWithMakeBridge(
        parentWorkflow,
        { runId: "parent-run" },
        async (workflow, opts) => {
          calls.push({ workflow, runId: opts.runId });
          if (workflow === childWorkflow) {
            return { runId: opts.runId, status: "finished" };
          }
          const runtime = getWorkflowMakeBridgeRuntime();
          expect(runtime).toBeDefined();
          expect(await runtime.executeChildWorkflow(childWorkflow, { runId: "child-run" })).toEqual({
            runId: "child-run",
            status: "finished",
          });
          return { runId: opts.runId, status: "finished" };
        },
      );
      expect(result).toEqual({ runId: "parent-run", status: "finished" });
      expect(calls).toEqual([
        { workflow: parentWorkflow, runId: "parent-run" },
        { workflow: childWorkflow, runId: "child-run" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("throws failed workflow exits", async () => {
    const { db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const workflow = { db };
      await expect(
        runWorkflowWithMakeBridge(workflow, { runId: "failed-run" }, async () => {
          throw new Error("body failed");
        }),
      ).rejects.toThrow("body failed");
    } finally {
      cleanup();
    }
  });
});
