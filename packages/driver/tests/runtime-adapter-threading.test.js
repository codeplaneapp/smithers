import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Effect } from "effect";
import { SmithersCtx } from "../src/SmithersCtx.js";
import { WorkflowDriver } from "../src/WorkflowDriver.js";
import { RuntimeCapabilityError } from "../src/RuntimeCapabilityError.js";
import { createBrowserRuntime } from "../src/browser-runtime.js";

const runtime = {
  runPromise(value) {
    return value && typeof value.pipe === "function"
      ? Effect.runPromise(value)
      : Promise.resolve(value);
  },
};

function makeSession(overrides = {}) {
  return {
    submitGraph: () => ({ _tag: "Finished", result: { runId: "run-1", status: "finished" } }),
    taskCompleted: () => ({ _tag: "Finished", result: { runId: "run-1", status: "finished" } }),
    taskFailed: () => ({ _tag: "Failed", error: new Error("task failed") }),
    ...overrides,
  };
}

describe("SmithersCtx.resolveWorktreePath", () => {
  test("throws a typed RuntimeCapabilityError when no resolver is configured", () => {
    const ctx = new SmithersCtx({ runId: "r1", iteration: 0, input: {}, outputs: {} });
    expect(() => ctx.resolveWorktreePath("./lane")).toThrow(RuntimeCapabilityError);
  });

  test("delegates to the injected runtimeConfig.resolveWorktreePath resolver", () => {
    const ctx = new SmithersCtx({
      runId: "r1",
      iteration: 0,
      input: {},
      outputs: {},
      runtimeConfig: {
        baseRootDir: "/repo/.smithers/workflows",
        resolveWorktreePath: (path, opts) => resolve(opts?.baseRootDir ?? "", path),
      },
    });
    expect(ctx.resolveWorktreePath(".smithers/wt/t1")).toBe(
      resolve("/repo/.smithers/workflows", ".smithers/wt/t1"),
    );
  });
});

describe("WorkflowDriver runtimeAdapter threading", () => {
  test("forwards runtimeAdapter.worktree.resolve into both the ctx runtimeConfig and the render() opts", async () => {
    let seenRenderOpts;
    const resolveWorktreePathSpy = (path, opts) => `resolved:${path}:${opts?.baseRootDir ?? ""}`;
    const runtimeAdapter = {
      name: "test-runtime",
      worktree: { resolve: resolveWorktreePathSpy },
    };
    let seenCtx;
    const driver = new WorkflowDriver({
      workflow: {
        db: null,
        zodToKeyName: new Map(),
        build: (ctx) => {
          seenCtx = ctx;
          return { ctx };
        },
      },
      runtime,
      renderer: {
        render: async (_element, opts) => {
          seenRenderOpts = opts;
          return { xml: null, tasks: [], mountedTaskIds: [] };
        },
      },
      session: makeSession(),
      runtimeAdapter,
      rootDir: "/root",
    });

    await driver.renderAndSubmit({ runId: "run-1", iteration: 0, outputs: {} });

    expect(seenRenderOpts.resolveWorktreePath).toBe(resolveWorktreePathSpy);
    expect(seenCtx.resolveWorktreePath("lane")).toBe("resolved:lane:/root");
  });

  test("prefers an explicit executeTask override, then runtimeAdapter.executeTask, then the built-in default", async () => {
    const calls = [];
    const runtimeAdapter = {
      name: "test-runtime",
      executeTask: (task) => {
        calls.push("adapter");
        return `adapter:${task.nodeId}`;
      },
    };
    const driverWithAdapterOnly = new WorkflowDriver({
      workflow: { db: null, zodToKeyName: new Map(), build: (ctx) => ({ ctx }) },
      runtime,
      renderer: { render: async () => ({ xml: null, tasks: [], mountedTaskIds: [] }) },
      session: makeSession(),
      runtimeAdapter,
    });
    driverWithAdapterOnly.activeRunId = "run-1";
    driverWithAdapterOnly.activeOptions = { input: {} };
    const decision = await driverWithAdapterOnly.executeTasks([{ nodeId: "t1", iteration: 0 }]);
    expect(decision).toEqual({ _tag: "Finished", result: { runId: "run-1", status: "finished" } });
    expect(calls).toEqual(["adapter"]);

    const explicitCalls = [];
    const driverWithExplicit = new WorkflowDriver({
      workflow: { db: null, zodToKeyName: new Map(), build: (ctx) => ({ ctx }) },
      runtime,
      renderer: { render: async () => ({ xml: null, tasks: [], mountedTaskIds: [] }) },
      session: makeSession(),
      runtimeAdapter,
      executeTask: (task) => {
        explicitCalls.push("explicit");
        return `explicit:${task.nodeId}`;
      },
    });
    driverWithExplicit.activeRunId = "run-1";
    driverWithExplicit.activeOptions = { input: {} };
    await driverWithExplicit.executeTasks([{ nodeId: "t1", iteration: 0 }]);
    expect(explicitCalls).toEqual(["explicit"]);
  });

  test("threads runtimeAdapter.storage through the full lifecycle: resume seeds outputs, every completed task output is persisted, failures persist run state", async () => {
    const savedRuns = new Map();
    const savedOutputs = new Map();
    const runtimeAdapter = createBrowserRuntime();
    // Seed the browser runtime's own storage with the exact shape WorkflowDriver expects to resume from.
    await runtimeAdapter.storage.saveOutputs("run-resume", { seed_output: [{ nodeId: "seed", iteration: 0, value: 1 }] });

    const decisions = [
      { _tag: "Execute", tasks: [{ nodeId: "agentTask", iteration: 0 }] },
      { _tag: "Execute", tasks: [{ nodeId: "computeTask", iteration: 0 }] },
      { _tag: "Finished", result: { runId: "run-resume", status: "finished" } },
    ];
    const driver = new WorkflowDriver({
      workflow: { db: null, zodToKeyName: new Map(), build: (ctx) => ({ ctx }) },
      runtime,
      renderer: {
        render: async () => ({
          xml: null,
          tasks: [
            { nodeId: "agentTask", iteration: 0, outputTableName: "agent_output" },
            { nodeId: "computeTask", iteration: 0, outputTableName: "dependent_output" },
          ],
          mountedTaskIds: [],
        }),
      },
      session: makeSession({
        submitGraph: () => decisions.shift(),
        taskCompleted: () => decisions.shift(),
      }),
      runtimeAdapter,
      executeTask: (task) =>
        task.nodeId === "agentTask" ? { summary: "agent-done" } : { derived: "compute-done" },
    });

    const result = await driver.run({ runId: "run-resume", input: {} });
    expect(result).toEqual({ runId: "run-resume", status: "finished" });

    const persisted = await runtimeAdapter.storage.loadOutputs("run-resume");
    expect(persisted.seed_output).toEqual([{ nodeId: "seed", iteration: 0, value: 1 }]);
    expect(persisted.agent_output).toEqual([
      { summary: "agent-done", nodeId: "agentTask", iteration: 0, __smithersProvenanceSeq: 0 },
    ]);
    expect(persisted.dependent_output).toEqual([
      { derived: "compute-done", nodeId: "computeTask", iteration: 0, __smithersProvenanceSeq: 1 },
    ]);

    const storedRun = await runtimeAdapter.storage.loadRun("run-resume");
    expect(storedRun.status).toBe("finished");
  });

  test("persists failed run state through runtimeAdapter.storage", async () => {
    const runtimeAdapter = createBrowserRuntime();
    const driver = new WorkflowDriver({
      workflow: { db: null, zodToKeyName: new Map(), build: (ctx) => ({ ctx }) },
      runtime,
      renderer: { render: async () => ({ xml: null, tasks: [], mountedTaskIds: [] }) },
      session: makeSession({
        submitGraph: () => ({ _tag: "Failed", error: new Error("boom") }),
      }),
      runtimeAdapter,
    });

    const result = await driver.run({ runId: "run-fail", input: {} });
    expect(result.status).toBe("failed");

    const storedRun = await runtimeAdapter.storage.loadRun("run-fail");
    expect(storedRun.status).toBe("failed");
    expect(storedRun.error).toBeTruthy();
  });
});
