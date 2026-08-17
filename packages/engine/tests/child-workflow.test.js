import { describe, expect, test } from "bun:test";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { __childWorkflowInternals, executeChildWorkflow } from "../src/child-workflow.js";
import { withWorkflowMakeBridgeRuntime } from "../src/effect/workflow-make-bridge.js";
import { RUN_ID_PATTERN } from "../../server/src/gatewayRoutes/RUN_ID_PATTERN.js";
import { JUMP_RUN_ID_PATTERN } from "../../time-travel/src/JUMP_RUN_ID_PATTERN.js";

function makeRuntime(overrides = {}) {
  return {
    runId: "parent-run",
    stepId: "step",
    attempt: 1,
    iteration: 2,
    signal: new AbortController().signal,
    db: null,
    heartbeat: () => {},
    lastHeartbeat: null,
    ...overrides,
  };
}

describe("child workflow helpers", () => {
  test("normalizes inputs, outputs and workflow definitions", () => {
    expect(__childWorkflowInternals.normalizeChildInput(null)).toEqual({});
    expect(__childWorkflowInternals.normalizeChildInput({ a: 1 })).toEqual({ a: 1 });
    expect(__childWorkflowInternals.normalizeChildInput(["x"])).toEqual({ value: ["x"] });
    expect(__childWorkflowInternals.buildChildWorkflowRunId("parent", "node", 3)).toBe("parent:child:node:3");
    expect(() => __childWorkflowInternals.buildValidatedChildRunId("parent", "review/security", 0)).toThrow(
      "cannot be persisted in a Gateway-readable child run id",
    );
    const scopedChildRunId = __childWorkflowInternals.buildValidatedChildRunId("parent", "review@@outer=0,inner=1", 2);
    expect(RUN_ID_PATTERN.test(scopedChildRunId)).toBe(true);
    expect(JUMP_RUN_ID_PATTERN.test(scopedChildRunId)).toBe(true);

    expect(
      __childWorkflowInternals.stripSystemColumns({
        runId: "r",
        nodeId: "n",
        iteration: 1,
        value: { nodeId: "nested", ok: true },
        rows: [{ runId: "x", value: 2 }],
      }),
    ).toEqual({
      value: { nodeId: "nested", ok: true },
      rows: [{ runId: "x", value: 2 }],
    });
    expect(__childWorkflowInternals.stripSystemColumns([{ runId: "r", value: 1 }])).toEqual([{ value: 1 }]);
    expect(__childWorkflowInternals.normalizeChildOutput({ status: "finished", output: [] })).toBe(null);
    // The documented childRun contract: a single result row (the child's
    // last task's row) unwraps to that plain row object, never a
    // table-keyed snapshot or a one-element array.
    expect(
      __childWorkflowInternals.normalizeChildOutput({
        status: "finished",
        output: [{ runId: "r", nodeId: "final", iteration: 0, summary: "done" }],
      }),
    ).toEqual({ summary: "done" });
    expect(
      __childWorkflowInternals.normalizeChildOutput({
        status: "finished",
        output: [
          { runId: "r", nodeId: "a", iteration: 0, value: 1 },
          { runId: "r", nodeId: "b", iteration: 0, value: 2 },
        ],
      }),
    ).toEqual([{ value: 1 }, { value: 2 }]);
    expect(
      __childWorkflowInternals.normalizeChildOutput({
        status: "finished",
        output: { runId: "r", value: 3 },
      }),
    ).toEqual({ value: 3 });

    const parent = { db: "db", schemaRegistry: "registry", zodToKeyName: "names" };
    const childObject = {
      db: "child-db",
      build: () => "child",
      opts: { cache: true },
      schemaRegistry: "child-registry",
      zodToKeyName: "child-names",
    };
    expect(__childWorkflowInternals.resolveChildWorkflow(childObject, parent)).toMatchObject({
      db: "child-db",
      opts: { cache: true },
      schemaRegistry: "child-registry",
      zodToKeyName: "child-names",
    });

    const rendered = __childWorkflowInternals.resolveChildWorkflow(() => () => "rendered", parent);
    expect(rendered.db).toBe("db");
    expect(rendered.build({})).toBe("rendered");
    expect(() => __childWorkflowInternals.resolveChildWorkflow(() => () => null)).toThrow("parent workflow context");
    expect(() => __childWorkflowInternals.resolveChildWorkflow(123, parent)).toThrow("Child workflow must be");
  });

  test("executes child workflows through the workflow make bridge runtime", async () => {
    const { smithers, cleanup } = createTestSmithers(outputSchemas);
    try {
      const childWorkflow = smithers(() => null);
      ensureSmithersTables(childWorkflow.db);
      await new SmithersDb(childWorkflow.db).insertRun({
        runId: "parent-run",
        workflowName: "parent",
        status: "running",
        createdAtMs: Date.now(),
        configJson: JSON.stringify({
          gatewayWorkflowKey: "main",
          gatewaySystem: true,
          startedBy: { kind: "user", id: "tester" },
        }),
      });
      const runtime = makeRuntime({ db: childWorkflow.db, acceptWorkflowChange: true });
      let capturedOptions;
      const bridgeRuntime = {
        executeChildWorkflow: async (_workflow, opts) => {
          capturedOptions = opts;
          return {
            runId: opts.runId,
            status: "finished",
            output: [{ runId: opts.runId, nodeId: "child", iteration: 2, value: 42 }],
          };
        },
      };

      const result = await withTaskRuntime(runtime, () =>
        withWorkflowMakeBridgeRuntime(bridgeRuntime, () =>
          executeChildWorkflow(childWorkflow, {
            workflow: childWorkflow,
            input: "prompt",
            allowNetwork: true,
            maxOutputBytes: 1024,
            toolTimeoutMs: 250,
          }),
        ),
      );

      expect(result).toEqual({
        runId: "parent-run:child:step:2",
        status: "finished",
        output: { value: 42 },
      });
      expect(capturedOptions).toMatchObject({
        input: { value: "prompt" },
        runId: "parent-run:child:step:2",
        resume: false,
        acceptWorkflowChange: true,
        parentRunId: "parent-run",
        config: {
          gatewayWorkflowKey: "main",
          gatewaySystem: true,
          subflowWorkspaceParentRunId: "parent-run",
        },
        startedBy: { kind: "user", id: "tester" },
        allowNetwork: true,
        maxOutputBytes: 1024,
        toolTimeoutMs: 250,
      });
    } finally {
      cleanup();
    }
  });

  test("refuses to launch a new child once the parent has a durable cancel request", async () => {
    const { smithers, cleanup } = createTestSmithers(outputSchemas);
    try {
      const childWorkflow = smithers(() => null);
      ensureSmithersTables(childWorkflow.db);
      const adapter = new SmithersDb(childWorkflow.db);
      // A cancellation landed but the parent engine has not polled it yet:
      // without the fence it could still create a fresh ACTIVE descendant the
      // cascade already walked past (#972).
      await adapter.insertRun({
        runId: "parent-run",
        workflowName: "parent",
        status: "running",
        createdAtMs: Date.now(),
        cancelRequestedAtMs: Date.now(),
      });
      const runtime = makeRuntime({ db: childWorkflow.db });
      let launched = false;
      const bridgeRuntime = {
        executeChildWorkflow: async (_workflow, opts) => {
          launched = true;
          return { runId: opts.runId, status: "finished", output: [] };
        },
      };

      await expect(
        withTaskRuntime(runtime, () =>
          withWorkflowMakeBridgeRuntime(bridgeRuntime, () =>
            executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
          ),
        ),
      ).rejects.toThrow("was cancelled before child workflow");
      expect(launched).toBe(false);
      expect(await adapter.getRun("parent-run:child:step:2")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("refuses to launch a new child once the parent is terminally cancelled", async () => {
    const { smithers, cleanup } = createTestSmithers(outputSchemas);
    try {
      const childWorkflow = smithers(() => null);
      ensureSmithersTables(childWorkflow.db);
      const adapter = new SmithersDb(childWorkflow.db);
      await adapter.insertRun({
        runId: "parent-run",
        workflowName: "parent",
        status: "cancelled",
        createdAtMs: Date.now(),
        finishedAtMs: Date.now(),
      });
      const runtime = makeRuntime({ db: childWorkflow.db });

      await expect(
        withTaskRuntime(runtime, () =>
          withWorkflowMakeBridgeRuntime({ executeChildWorkflow: async () => ({}) }, () =>
            executeChildWorkflow(childWorkflow, { workflow: childWorkflow }),
          ),
        ),
      ).rejects.toThrow("was cancelled before child workflow");
    } finally {
      cleanup();
    }
  });

  test("rejects an unreadable generated child run id before persistence", async () => {
    const { smithers, db, cleanup } = createTestSmithers(outputSchemas);
    try {
      const childWorkflow = smithers(() => null);
      const runtime = makeRuntime({ db, stepId: "review/security" });
      await expect(
        withTaskRuntime(runtime, () => executeChildWorkflow(childWorkflow, { workflow: childWorkflow })),
      ).rejects.toThrow("cannot be persisted in a Gateway-readable child run id");
      expect(await new SmithersDb(db).getRun("parent-run:child:review/security:2")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("executes child workflows through runWorkflow when no make bridge runtime exists", async () => {
    const { smithers, cleanup } = createTestSmithers(outputSchemas);
    try {
      const childWorkflow = smithers(() => null);
      ensureSmithersTables(childWorkflow.db);
      const runtime = makeRuntime({ db: childWorkflow.db });

      const result = await withTaskRuntime(runtime, () =>
        executeChildWorkflow(childWorkflow, {
          workflow: childWorkflow,
          input: { ok: true },
          runId: "explicit-child-run",
          parentRunId: "explicit-parent",
          rootDir: process.cwd(),
          workflowPath: "workflow.tsx",
          allowNetwork: false,
          maxOutputBytes: 2048,
          toolTimeoutMs: 300,
        }),
      );

      expect(result.runId).toBe("explicit-child-run");
      expect(result.status).toBe("finished");
    } finally {
      cleanup();
    }
  });
});
