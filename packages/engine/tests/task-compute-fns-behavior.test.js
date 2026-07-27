import { describe, expect, test } from "bun:test";
import { attachSandboxComputeFns, attachSubflowComputeFns } from "../src/task-compute-fns.js";

const childWorkflowCalls = [];
const sandboxCalls = [];
let nextChildWorkflowResult = { status: "finished", output: { child: "ok" } };
let nextSandboxResult = { status: "finished", output: { sandbox: "ok" } };

const testDeps = {
  executeChildWorkflow: async (...args) => {
    childWorkflowCalls.push(args);
    return nextChildWorkflowResult;
  },
  executeSandbox: async (options) => {
    sandboxCalls.push(options);
    return nextSandboxResult;
  },
  applyDiffBundle: async () => ({ changed: false }),
};

describe("task compute function attachment behavior", () => {
  test("subflow compute functions execute child workflows with propagated options and return finished output", async () => {
    childWorkflowCalls.length = 0;
    nextChildWorkflowResult = { status: "finished", output: { child: "ok" } };

    const parentWorkflow = { name: "parent" };
    const subflowWorkflow = { name: "child" };
    const tasks = [
      {
        nodeId: "subflow-node",
        meta: {
          __subflow: true,
          __subflowWorkflow: subflowWorkflow,
          __subflowInput: { value: 42 },
        },
      },
    ];

    attachSubflowComputeFns(tasks, parentWorkflow, { rootDir: "/repo", workflowPath: null, ...testDeps });

    await expect(tasks[0].computeFn()).resolves.toEqual({ child: "ok" });
    expect(childWorkflowCalls).toEqual([
      [
        parentWorkflow,
        {
          workflow: subflowWorkflow,
          input: { value: 42 },
          rootDir: "/repo",
          workflowPath: undefined,
        },
      ],
    ]);
  });

  test("subflow compute functions throw when the child workflow does not finish", async () => {
    childWorkflowCalls.length = 0;
    nextChildWorkflowResult = { runId: "failed-child", status: "failed", output: null };

    const tasks = [
      {
        nodeId: "bad-subflow",
        meta: {
          __subflow: true,
          __subflowWorkflow: { name: "child" },
          __subflowInput: { value: "bad" },
        },
      },
    ];

    attachSubflowComputeFns(tasks, { name: "parent" }, testDeps);

    await expect(tasks[0].computeFn()).rejects.toThrow(
      "Subflow bad-subflow failed because child run failed-child ended with status failed.",
    );
    expect(childWorkflowCalls).toHaveLength(1);
  });

  test("subflow compute functions classify a parked child as a non-retryable suspension", async () => {
    childWorkflowCalls.length = 0;
    nextChildWorkflowResult = {
      runId: "parked-child",
      status: "waiting-approval",
      output: null,
    };
    const tasks = [
      {
        nodeId: "parked-subflow",
        meta: {
          __subflow: true,
          __subflowWorkflow: { name: "child" },
        },
      },
    ];

    attachSubflowComputeFns(tasks, { name: "parent" }, testDeps);

    await expect(tasks[0].computeFn()).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_FAILED",
      details: {
        childRunId: "parked-child",
        status: "waiting-approval",
        suspensionStatus: "waiting-approval",
        failureRetryable: false,
      },
    });
  });

  test("subflow compute functions classify a structured approval denial as non-retryable", async () => {
    childWorkflowCalls.length = 0;
    nextChildWorkflowResult = {
      runId: "denied-child",
      status: "failed",
      output: null,
      error: {
        code: "SESSION_ERROR",
        cause: { approved: false, note: "not this quarter" },
      },
    };
    const tasks = [
      {
        nodeId: "denied-subflow",
        meta: {
          __subflow: true,
          __subflowWorkflow: { name: "child" },
        },
      },
    ];

    attachSubflowComputeFns(tasks, { name: "parent" }, testDeps);

    await expect(tasks[0].computeFn()).rejects.toMatchObject({
      summary: "Subflow denied-subflow failed because child run denied-child denied an approval.",
      details: {
        childRunId: "denied-child",
        childError: {
          cause: { approved: false, note: "not this quarter" },
        },
        failureRetryable: false,
      },
    });
  });

  test("sandbox compute functions execute sandbox workflows with coerced flags, defaults, and task worktree root", async () => {
    sandboxCalls.length = 0;
    nextSandboxResult = { status: "finished", output: { sandbox: "ok" } };

    const parentWorkflow = { name: "parent" };
    const sandboxWorkflow = { name: "sandbox" };
    const tasks = [
      {
        nodeId: "sandbox-node",
        worktreePath: "/worktree",
        meta: {
          __sandbox: true,
          __sandboxWorkflow: sandboxWorkflow,
          __sandboxInput: { prompt: "run" },
          __sandboxProvider: "local",
          __sandboxRuntime: "bun",
          __sandboxAllowNetwork: "yes",
          __sandboxReviewDiffs: false,
          __sandboxAutoAcceptDiffs: true,
          __sandboxAllowNested: 0,
          __sandboxConfig: { image: "smithers-test" },
        },
      },
    ];

    attachSandboxComputeFns(tasks, parentWorkflow, { rootDir: "/repo", ...testDeps });

    await expect(tasks[0].computeFn()).resolves.toEqual({ status: "finished", output: { sandbox: "ok" } });
    expect(sandboxCalls).toHaveLength(1);
    expect(sandboxCalls[0]).toMatchObject({
      parentWorkflow,
      sandboxId: "sandbox-node",
      provider: "local",
      runtime: "bun",
      workflow: sandboxWorkflow,
      input: { prompt: "run" },
      rootDir: "/worktree",
      allowNetwork: true,
      maxOutputBytes: 200_000,
      toolTimeoutMs: 60_000,
      reviewDiffs: false,
      autoAcceptDiffs: true,
      allowNested: false,
      config: { image: "smithers-test" },
    });
    expect(typeof sandboxCalls[0].executeChildWorkflow).toBe("function");
    expect(typeof sandboxCalls[0].applyDiffBundle).toBe("function");
  });

  test("sandbox compute functions fall back to opts root and empty config for invalid metadata", async () => {
    sandboxCalls.length = 0;
    nextSandboxResult = { status: "finished", output: null };

    const tasks = [
      {
        nodeId: "sandbox-defaults",
        meta: {
          __sandbox: true,
          __sandboxWorkflow: { name: "sandbox" },
          __sandboxAllowNetwork: 0,
          __sandboxAllowNested: "nested",
          __sandboxConfig: "not an object",
        },
      },
    ];

    attachSandboxComputeFns(tasks, { name: "parent" }, { rootDir: "/repo", ...testDeps });

    await tasks[0].computeFn();
    expect(sandboxCalls[0]).toMatchObject({
      sandboxId: "sandbox-defaults",
      rootDir: "/repo",
      allowNetwork: false,
      allowNested: true,
      config: {},
    });
  });
});
