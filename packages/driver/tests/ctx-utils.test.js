import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { buildCurrentScopes } from "../src/buildCurrentScopes.js";
import { defaultTaskExecutor } from "../src/defaultTaskExecutor.js";
import { filterRowsByNodeId } from "../src/filterRowsByNodeId.js";
import { ignoreSyncError } from "../src/ignoreSyncError.js";
import { normalizeInputRow } from "../src/normalizeInputRow.js";
import { SmithersCtx } from "../src/SmithersCtx.js";
import { WorkflowDriver } from "../src/WorkflowDriver.js";
import {
  getTaskRuntime,
  requireTaskRuntime,
  withTaskRuntime,
} from "../src/task-runtime.js";
import { withAbort } from "../src/withAbort.js";
import { withLogicalIterationShortcuts } from "../src/withLogicalIterationShortcuts.js";

function makeCtx(overrides = {}) {
  return new SmithersCtx({
    runId: "run-1",
    iteration: 0,
    input: {},
    outputs: {},
    ...overrides,
  });
}

const numberSchema = {
  safeParse(value) {
    return typeof value === "number"
      ? { success: true, data: value }
      : { success: false, error: new Error("not number") };
  },
};

const runtime = {
  runPromise(value) {
    return value && typeof value.pipe === "function"
      ? Effect.runPromise(value)
      : Promise.resolve(value);
  },
};

function makeSession(overrides = {}) {
  return {
    submitGraph: () => ({ _tag: "Finished", result: { runId: "run-session", status: "finished" } }),
    taskCompleted: () => ({ _tag: "Finished", result: { runId: "run-session", status: "finished" } }),
    taskFailed: () => ({ _tag: "Failed", error: new Error("task failed") }),
    ...overrides,
  };
}

function makeDriver(overrides = {}) {
  return new WorkflowDriver({
    workflow: {
      db: null,
      zodToKeyName: new Map(),
      build: (ctx) => ({ ctx }),
    },
    runtime,
    renderer: {
      render: async () => ({ tasks: [] }),
    },
    session: makeSession(),
    ...overrides,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition) {
  for (let i = 0; i < 20; i += 1) {
    if (condition())
      return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("normalizeInputRow", () => {
  test("leaves primitives unchanged", () => {
    expect(normalizeInputRow(null)).toBeNull();
    expect(normalizeInputRow("x")).toBe("x");
    expect(normalizeInputRow(1)).toBe(1);
  });

  test("leaves objects without payload unchanged", () => {
    const input = { runId: "r1", value: 1 };
    expect(normalizeInputRow(input)).toBe(input);
  });

  test("leaves rows with extra keys unchanged", () => {
    const input = { runId: "r1", payload: "{}", extra: true };
    expect(normalizeInputRow(input)).toBe(input);
  });

  test("nullish payload normalizes to empty object", () => {
    expect(normalizeInputRow({ runId: "r1", payload: null })).toEqual({});
    expect(normalizeInputRow({ runId: "r1", payload: undefined })).toEqual({});
  });

  test("JSON object payload is parsed", () => {
    expect(normalizeInputRow({ payload: '{"a":1}' })).toEqual({ a: 1 });
  });

  test("JSON array payload is parsed", () => {
    expect(normalizeInputRow({ payload: "[1,2,3]" })).toEqual([1, 2, 3]);
  });

  test("invalid JSON string payload is returned as a string", () => {
    expect(normalizeInputRow({ payload: "{nope" })).toBe("{nope");
  });

  test("renderAndSubmit forwards render trigger metadata to the renderer", async () => {
    let seenRenderOpts;
    const trigger = { reason: "task-finished", nodeId: "fast", iteration: 0 };
    const driver = makeDriver({
      renderer: {
        render: async (_element, opts) => {
          seenRenderOpts = opts;
          return { xml: null, tasks: [], mountedTaskIds: [] };
        },
      },
      session: makeSession({
        submitGraph: () => ({ _tag: "Finished", result: { runId: "run-1", status: "finished" } }),
      }),
    });

    await driver.renderAndSubmit({
      runId: "run-1",
      iteration: 0,
      outputs: {},
      trigger,
    });

    expect(seenRenderOpts.trigger).toEqual(trigger);
  });

  test("non-string payload is returned directly", () => {
    const payload = { nested: true };
    expect(normalizeInputRow({ runId: "r1", payload })).toBe(payload);
  });
});

describe("filterRowsByNodeId", () => {
  const rows = [
    { nodeId: "task", iteration: 0, value: "exact-0" },
    { nodeId: "task", iteration: 1, value: "exact-1" },
    { nodeId: "task@@outer=1", iteration: 0, value: "scoped-1" },
    { nodeId: "task@@outer=1,inner=2", iteration: 0, value: "scoped-deep" },
    { nodeId: "other", iteration: 0, value: "other" },
  ];

  test("returns exact rows first", () => {
    expect(filterRowsByNodeId(rows, "task", new Set()).map((r) => r.value))
      .toEqual(["exact-0", "exact-1"]);
  });

  test("exact rows win over scoped fallback", () => {
    expect(
      filterRowsByNodeId(rows, "task", new Set(["@@outer=1"])).map((r) => r.value),
    ).toEqual(["exact-0", "exact-1"]);
  });

  test("falls back to scoped rows when exact rows are absent", () => {
    const scopedOnly = rows.filter((row) => row.nodeId !== "task");
    expect(
      filterRowsByNodeId(scopedOnly, "task", new Set(["@@outer=1"])).map(
        (r) => r.value,
      ),
    ).toEqual(["scoped-1"]);
  });

  test("uses the longest matching current scope first", () => {
    const scopedOnly = rows.filter((row) => row.nodeId !== "task");
    expect(
      filterRowsByNodeId(
        scopedOnly,
        "task",
        new Set(["@@outer=1", "@@outer=1,inner=2"]),
      ).map((r) => r.value),
    ).toEqual(["scoped-deep"]);
  });

  test("scoped lookup id does not fallback to other scopes", () => {
    expect(
      filterRowsByNodeId(rows, "task@@outer=2", new Set(["@@outer=1"])),
    ).toEqual([]);
  });

  test("returns empty array for missing node id", () => {
    expect(filterRowsByNodeId(rows, "none", new Set())).toEqual([]);
  });
});

describe("iteration scope helpers", () => {
  test("buildCurrentScopes returns empty set without iterations", () => {
    expect(buildCurrentScopes()).toEqual(new Set());
  });

  test("buildCurrentScopes ignores unscoped ids", () => {
    expect(buildCurrentScopes({ outer: 2 })).toEqual(new Set());
  });

  test("buildCurrentScopes rewrites ancestor iterations to current values", () => {
    expect(buildCurrentScopes({ outer: 3, "inner@@outer=1": 4 }))
      .toEqual(new Set(["@@outer=3"]));
  });

  test("buildCurrentScopes preserves unknown ancestor scope parts", () => {
    expect(buildCurrentScopes({ "inner@@outer=1": 4 }))
      .toEqual(new Set(["@@outer=1"]));
  });

  test("buildCurrentScopes skips malformed scope parts", () => {
    expect(buildCurrentScopes({ "inner@@outer": 4 })).toEqual(new Set());
  });

  test("buildCurrentScopes handles multiple ancestors", () => {
    expect(
      buildCurrentScopes({
        outer: 2,
        middle: 5,
        "inner@@outer=1,middle=4": 7,
      }),
    ).toEqual(new Set(["@@outer=2,middle=5"]));
  });

  test("withLogicalIterationShortcuts returns undefined unchanged", () => {
    expect(withLogicalIterationShortcuts()).toBeUndefined();
  });

  test("withLogicalIterationShortcuts returns unscoped-only object unchanged", () => {
    const iterations = { outer: 2 };
    expect(withLogicalIterationShortcuts(iterations)).toBe(iterations);
  });

  test("withLogicalIterationShortcuts maps current scoped id to logical id", () => {
    expect(withLogicalIterationShortcuts({ outer: 2, "inner@@outer=2": 7 }))
      .toEqual({ outer: 2, "inner@@outer=2": 7, inner: 7 });
  });

  test("withLogicalIterationShortcuts leaves stale scoped id at logical zero", () => {
    expect(withLogicalIterationShortcuts({ outer: 3, "inner@@outer=2": 7 }))
      .toEqual({ outer: 3, "inner@@outer=2": 7, inner: 0 });
  });

  test("withLogicalIterationShortcuts handles malformed scope as non-current", () => {
    expect(withLogicalIterationShortcuts({ "inner@@outer": 7 }))
      .toEqual({ "inner@@outer": 7, inner: 0 });
  });
});

describe("SmithersCtx output access", () => {
  test("normalizes input payload rows in constructor", () => {
    const ctx = makeCtx({ input: { runId: "r1", payload: '{"ok":true}' } });
    expect(ctx.input).toEqual({ ok: true });
  });

  test("resolves Worktree path props against the runtime root", () => {
    const ctx = makeCtx({
      runtimeConfig: {
        baseRootDir: "/repo/.smithers/workflows",
      },
    });

    expect(ctx.resolveWorktreePath(".smithers/wt/t1")).toBe("/repo/.smithers/workflows/.smithers/wt/t1");
  });

  test("looks up resolved Worktree paths by task or worktree id", () => {
    const ctx = makeCtx({
      runtimeConfig: {
        worktreePaths: {
          "build:t1:verify": "/repo/.smithers/workflows/.smithers/wt/t1",
          "ticket-t1": "/repo/.smithers/workflows/.smithers/wt/t1",
        },
      },
    });

    expect(ctx.worktreePath("build:t1:verify")).toBe("/repo/.smithers/workflows/.smithers/wt/t1");
    expect(ctx.worktreePath("ticket-t1")).toBe("/repo/.smithers/workflows/.smithers/wt/t1");
    expect(ctx.worktreePath("missing")).toBeUndefined();
  });

  test("exposes outputs as callable accessor and named properties", () => {
    const rows = [{ nodeId: "a", iteration: 0, value: 1 }];
    const ctx = makeCtx({ outputs: { rows } });
    expect(ctx.outputs("rows")).toBe(rows);
    expect(ctx.outputs.rows).toBe(rows);
  });

  test("output returns exact node and iteration row", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output("rows", { nodeId: "a", iteration: 0 }).value).toBe(1);
  });

  test("output throws clear SmithersError when row is missing", () => {
    const ctx = makeCtx({ outputs: { rows: [] } });
    expect(() => ctx.output("rows", { nodeId: "missing", iteration: 0 }))
      .toThrow(/Missing output/);
  });

  test("outputMaybe returns undefined when row is missing", () => {
    const ctx = makeCtx({ outputs: { rows: [] } });
    expect(ctx.outputMaybe("rows", { nodeId: "missing", iteration: 0 }))
      .toBeUndefined();
  });

  test("resolveRow defaults missing key iteration to current iteration", () => {
    const ctx = makeCtx({
      iteration: 2,
      outputs: { rows: [{ nodeId: "a", iteration: 2, value: "current" }] },
    });
    expect(ctx.output("rows", { nodeId: "a" }).value).toBe("current");
  });

  test("latest picks highest numeric iteration", () => {
    const ctx = makeCtx({
      outputs: {
        rows: [
          { nodeId: "a", iteration: 0, value: "zero" },
          { nodeId: "a", iteration: 2, value: "two" },
          { nodeId: "a", iteration: 1, value: "one" },
        ],
      },
    });
    expect(ctx.latest("rows", "a").value).toBe("two");
  });

  test("latest treats missing iteration as zero", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", value: "zero" }] },
    });
    expect(ctx.latest("rows", "a").value).toBe("zero");
  });

  test("iterationCount counts distinct numeric iterations", () => {
    const ctx = makeCtx({
      outputs: {
        rows: [
          { nodeId: "a", iteration: 0 },
          { nodeId: "a", iteration: 0 },
          { nodeId: "a", iteration: 1 },
          { nodeId: "a", iteration: "bad" },
        ],
      },
    });
    expect(ctx.iterationCount("rows", "a")).toBe(2);
  });

  test("zod table map resolves non-string table references", () => {
    const schema = {};
    const ctx = makeCtx({
      zodToKeyName: new Map([[schema, "rows"]]),
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output(schema, { nodeId: "a", iteration: 0 }).value).toBe(1);
  });

  test("drizzle-style table metadata resolves table name", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output({ _: { name: "rows" } }, { nodeId: "a", iteration: 0 }).value)
      .toBe(1);
  });

  test("direct table name property resolves table name", () => {
    const ctx = makeCtx({
      outputs: { rows: [{ nodeId: "a", iteration: 0, value: 1 }] },
    });
    expect(ctx.output({ name: "rows" }, { nodeId: "a", iteration: 0 }).value)
      .toBe(1);
  });

  test("scoped output fallback uses current loop scope", () => {
    const ctx = makeCtx({
      iterations: { outer: 2, "inner@@outer=1": 0 },
      outputs: {
        rows: [{ nodeId: "task@@outer=2", iteration: 0, value: "scoped" }],
      },
    });
    expect(ctx.output("rows", { nodeId: "task", iteration: 0 }).value).toBe("scoped");
  });

  test("exact output beats scoped fallback in context lookups", () => {
    const ctx = makeCtx({
      iterations: { outer: 2, "inner@@outer=1": 0 },
      outputs: {
        rows: [
          { nodeId: "task", iteration: 0, value: "exact" },
          { nodeId: "task@@outer=2", iteration: 0, value: "scoped" },
        ],
      },
    });
    expect(ctx.output("rows", { nodeId: "task", iteration: 0 }).value).toBe("exact");
  });

  test("resolveRow falls back to an unscoped producer across loop boundaries", () => {
    const ctx = makeCtx({
      iteration: 3,
      iterations: { outer: 3 },
      outputs: {
        rows: [
          { nodeId: "upstream", iteration: 0, value: "outside-loop" },
          { nodeId: "upstream@@outer=2", iteration: 0, value: "stale-loop" },
        ],
      },
    });

    expect(ctx.output("rows", { nodeId: "upstream" }).value).toBe("outside-loop");
    expect(ctx.outputMaybe("rows", { nodeId: "upstream", iteration: 3 }))
      .toBeUndefined();
  });

  test("recordDeferredDep stores valid deferred deps and ignores empty node ids", () => {
    const ctx = makeCtx();

    ctx.recordDeferredDep("", ["missing"]);
    ctx.recordDeferredDep("blocked", ["missing"]);
    ctx.recordDeferredDep("unknown", null);

    expect(ctx._deferredDeps).toEqual([
      { nodeId: "blocked", waitingOn: ["missing"] },
      { nodeId: "unknown", waitingOn: [] },
    ]);
  });
});

describe("SmithersCtx latestArray", () => {
  test("returns empty array for nullish values", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray(null, numberSchema)).toEqual([]);
    expect(ctx.latestArray(undefined, numberSchema)).toEqual([]);
  });

  test("parses JSON arrays and filters invalid entries", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("[1,\"x\",2]", numberSchema)).toEqual([1, 2]);
  });

  test("wraps JSON objects as a single candidate", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("3", numberSchema)).toEqual([3]);
  });

  test("returns empty array for invalid JSON strings", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray("{bad", numberSchema)).toEqual([]);
  });

  test("wraps scalar non-string values", () => {
    const ctx = makeCtx();
    expect(ctx.latestArray(4, numberSchema)).toEqual([4]);
  });
});

describe("task runtime and async helpers", () => {
  test("getTaskRuntime returns undefined outside runtime scope", () => {
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("requireTaskRuntime throws outside runtime scope", () => {
    expect(() => requireTaskRuntime()).toThrow(/task runtime is only available/);
  });

  test("withTaskRuntime scopes runtime to callback", () => {
    const runtime = { nodeId: "task-1", iteration: 0 };
    const result = withTaskRuntime(runtime, () => requireTaskRuntime());
    expect(result).toBe(runtime);
    expect(getTaskRuntime()).toBeUndefined();
  });

  test("withAbort resolves completed values", async () => {
    await expect(withAbort(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("withAbort rejects when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withAbort(new Promise(() => {}), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  test("withAbort rejects pending work on later abort", async () => {
    const controller = new AbortController();
    const promise = withAbort(new Promise(() => {}), controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("ignoreSyncError swallows cleanup errors", async () => {
    await expect(
      Effect.runPromise(
        ignoreSyncError("cleanup", () => {
          throw new Error("cleanup failed");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("defaultTaskExecutor", () => {
  test("executes compute functions, static payloads, agents, and prompt fallback", async () => {
    const context = { signal: undefined };
    await expect(defaultTaskExecutor({ computeFn: () => "computed" }, context))
      .resolves.toBe("computed");
    await expect(defaultTaskExecutor({ staticPayload: { ok: true } }, context))
      .resolves.toEqual({ ok: true });
    await expect(defaultTaskExecutor({ agent: [{ execute: () => "agent-execute" }] }, context))
      .resolves.toBe("agent-execute");
    await expect(defaultTaskExecutor({ agent: { run: () => "agent-run" } }, context))
      .resolves.toBe("agent-run");
    await expect(defaultTaskExecutor({ agent: { call: () => "agent-call" } }, context))
      .resolves.toBe("agent-call");
    await expect(defaultTaskExecutor({ agent: {}, prompt: "agentless prompt" }, context))
      .resolves.toBe("agentless prompt");
    await expect(defaultTaskExecutor({ prompt: "hello" }, context)).resolves.toBe("hello");
    await expect(defaultTaskExecutor({}, context)).resolves.toBeNull();
  });
});

describe("WorkflowDriver", () => {
  test("run creates a run id and returns a finished decision", async () => {
    const driver = makeDriver({
      session: makeSession({
        submitGraph: () => ({ _tag: "Finished", result: { runId: "generated", status: "finished" } }),
      }),
    });
    const result = await driver.run({ input: { value: 1 } });
    expect(result.status).toBe("finished");
    expect(driver.activeRunId).toMatch(/^run_/);
  });

  test("initializeSession accepts direct and Effect-created sessions", async () => {
    const directSession = makeSession();
    const directDriver = makeDriver({
      session: undefined,
      createSession: (options) => {
        expect(options.runId).toBe("run-direct");
        expect(options.rootDir).toBe("/root");
        expect(options.workflowPath).toBe("/workflow.tsx");
        return directSession;
      },
      rootDir: "/root",
      workflowPath: "/workflow.tsx",
    });
    await expect(directDriver.initializeSession("run-direct", {})).resolves.toBe(directSession);

    const effectSession = makeSession();
    const effectDriver = makeDriver({
      session: undefined,
      createSession: () => Effect.succeed(effectSession),
    });
    await expect(effectDriver.initializeSession("run-effect", {})).resolves.toBe(effectSession);
  });

  test("initializeSession can load the default scheduler session factory", async () => {
    const driver = makeDriver({ session: undefined, createSession: undefined });
    const session = await driver.initializeSession("run-loaded", {});
    expect(typeof session.submitGraph).toBe("function");
  });

  test("unknown engine decisions return a failed run result", async () => {
    const driver = makeDriver({
      session: makeSession({
        submitGraph: () => ({ _tag: "Mystery" }),
      }),
    });
    const result = await driver.run({ runId: "run-unknown", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error.message).toContain("Unknown engine decision");
  });

  test("fails finished runs with deferred deps as DEPENDENCY_DEADLOCK", async () => {
    const driver = makeDriver({
      workflow: {
        db: null,
        zodToKeyName: new Map(),
        build: (ctx) => {
          ctx.recordDeferredDep("blocked-task", ["missing-upstream"]);
          return { ctx };
        },
      },
      session: makeSession({
        submitGraph: () => ({
          _tag: "Finished",
          result: { runId: "run-deadlock", status: "finished" },
        }),
      }),
    });

    const result = await driver.run({ runId: "run-deadlock", input: {} });

    expect(result.status).toBe("failed");
    expect(result.error.name).toBe("SmithersError");
    expect(result.error.code).toBe("DEPENDENCY_DEADLOCK");
    expect(result.error.message).toContain("'blocked-task' never ran");
    expect(result.error.message).toContain("'missing-upstream'");
  });

  test("reports out-of-order task completions without waiting for slower siblings", async () => {
    const slow = deferred();
    const fast = deferred();
    const completed = [];
    const driver = makeDriver({
      executeTask: (task) => task.nodeId === "slow" ? slow.promise : fast.promise,
      session: makeSession({
        taskCompleted: ({ nodeId, output }) => {
          completed.push({ nodeId, output });
          return completed.length === 1
            ? { _tag: "Wait", reason: { _tag: "Event" } }
            : { _tag: "Finished", result: { runId: "run-ooo", status: "finished" } };
        },
      }),
    });
    driver.activeRunId = "run-ooo";
    driver.activeOptions = { input: {} };

    const firstDecisionPromise = driver.executeTasks([
      { nodeId: "slow", iteration: 0 },
      { nodeId: "fast", iteration: 0 },
    ]);
    fast.resolve("fast-output");
    const firstDecision = await firstDecisionPromise;

    expect(firstDecision).toEqual({ _tag: "Wait", reason: { _tag: "Event" } });
    expect(completed).toEqual([{ nodeId: "fast", output: "fast-output" }]);
    expect(driver.inflightTasks.size).toBe(1);

    const secondDecisionPromise = driver.handleWait({ _tag: "Event" });
    slow.resolve("slow-output");
    const secondDecision = await secondDecisionPromise;

    expect(secondDecision).toEqual({
      _tag: "Finished",
      result: { runId: "run-ooo", status: "finished" },
    });
    expect(completed).toEqual([
      { nodeId: "fast", output: "fast-output" },
      { nodeId: "slow", output: "slow-output" },
    ]);
  });

  test("reports failed task completions and falls back to getNextDecision", async () => {
    const failure = new Error("executor failed");
    const failed = [];
    const driver = makeDriver({
      executeTask: () => {
        throw failure;
      },
      session: makeSession({
        taskFailed: ({ nodeId, error }) => {
          failed.push({ nodeId, error });
          return undefined;
        },
        getNextDecision: () => ({
          _tag: "Finished",
          result: { runId: "run-failed-task", status: "finished" },
        }),
      }),
    });
    driver.activeRunId = "run-failed-task";
    driver.activeOptions = { input: {} };

    const decision = await driver.executeTasks([{ nodeId: "boom", iteration: 0 }]);

    expect(decision).toEqual({
      _tag: "Finished",
      result: { runId: "run-failed-task", status: "finished" },
    });
    expect(failed).toEqual([{ nodeId: "boom", error: failure }]);
  });

  test("rerenders, continues as new, and drains in-flight work before terminal exits", async () => {
    const slow = deferred();
    const decisions = [
      { _tag: "ReRender", context: { runId: "run-loop", iteration: 1, outputs: {} } },
      { _tag: "Execute", tasks: [{ nodeId: "slow", iteration: 0 }] },
      { _tag: "ContinueAsNew", transition: { next: true } },
    ];
    const driver = makeDriver({
      executeTask: () => slow.promise,
      continueAsNew: (transition, context) => ({
        runId: context.runId,
        status: "continued",
        output: transition,
      }),
      session: makeSession({
        submitGraph: () => decisions.shift(),
        taskCompleted: () => decisions.shift(),
      }),
    });

    const resultPromise = driver.run({ runId: "run-loop", input: {} });
    await waitFor(() => driver.inflightTasks.size === 1);
    expect(driver.inflightTasks.size).toBe(1);
    slow.resolve("done");
    const result = await resultPromise;

    expect(result).toEqual({
      runId: "run-loop",
      status: "continued",
      output: { next: true },
    });
    expect(driver.inflightTasks.size).toBe(0);
  });

  test("drains in-flight tasks before returning Failed decisions", async () => {
    const slow = deferred();
    const error = new Error("run failed");
    const driver = makeDriver({
      executeTask: () => slow.promise,
      session: makeSession({
        submitGraph: () => ({ _tag: "Execute", tasks: [{ nodeId: "slow", iteration: 0 }] }),
        taskCompleted: () => ({ _tag: "Failed", error }),
      }),
    });

    const resultPromise = driver.run({ runId: "run-failed", input: {} });
    await waitFor(() => driver.inflightTasks.size === 1);
    expect(driver.inflightTasks.size).toBe(1);
    slow.resolve("done");
    const result = await resultPromise;

    expect(result).toEqual({ runId: "run-failed", status: "failed", error });
    expect(driver.inflightTasks.size).toBe(0);
  });

  test("handles wait statuses, custom wait handlers, retry decisions, and timer fallback", async () => {
    const approvalDriver = makeDriver();
    approvalDriver.activeRunId = "run-wait";
    await expect(approvalDriver.handleWait({ _tag: "Approval" }))
      .resolves.toEqual({ runId: "run-wait", status: "waiting-approval" });
    await expect(approvalDriver.handleWait({ _tag: "Event" }))
      .resolves.toEqual({ runId: "run-wait", status: "waiting-event" });
    await expect(approvalDriver.handleWait({ _tag: "Timer", resumeAtMs: Date.now() }))
      .resolves.toEqual({ runId: "run-wait", status: "waiting-timer" });

    const customDriver = makeDriver({
      onWait: (reason, context) => ({
        runId: context.runId,
        status: "custom",
        output: reason._tag,
      }),
    });
    customDriver.activeRunId = "run-custom-wait";
    await expect(customDriver.handleWait({ _tag: "HotReload" }))
      .resolves.toEqual({ runId: "run-custom-wait", status: "custom", output: "HotReload" });

    const retryDriver = makeDriver({
      session: makeSession({
        getNextDecision: () => ({
          _tag: "Finished",
          result: { runId: "run-retry", status: "finished" },
        }),
      }),
    });
    retryDriver.activeRunId = "run-retry";
    retryDriver.activeOptions = { input: {} };
    await expect(retryDriver.handleWait({ _tag: "RetryBackoff", waitMs: 0 }))
      .resolves.toEqual({
        _tag: "Finished",
        result: { runId: "run-retry", status: "finished" },
      });
  });

  test("cancels through session decisions and aborted execution", async () => {
    const finishedCancelDriver = makeDriver({
      session: makeSession({
        cancelRequested: () => ({
          _tag: "Finished",
          result: { runId: "run-cancel", status: "finished", output: "cancelled-cleanly" },
        }),
      }),
    });
    finishedCancelDriver.activeRunId = "run-cancel";
    await expect(finishedCancelDriver.cancelRun()).resolves.toEqual({
      runId: "run-cancel",
      status: "finished",
      output: "cancelled-cleanly",
    });

    const failedCancelError = new Error("cancel failed");
    const failedCancelDriver = makeDriver({
      session: makeSession({
        cancelRequested: () => ({ _tag: "Failed", error: failedCancelError }),
      }),
    });
    failedCancelDriver.activeRunId = "run-cancel-failed";
    await expect(failedCancelDriver.cancelRun()).resolves.toEqual({
      runId: "run-cancel-failed",
      status: "failed",
      error: failedCancelError,
    });

    const controller = new AbortController();
    controller.abort();
    const abortedDriver = makeDriver();
    abortedDriver.activeRunId = "run-aborted";
    abortedDriver.activeOptions = { input: {}, signal: controller.signal };
    await expect(abortedDriver.executeTasks([{ nodeId: "never", iteration: 0 }]))
      .resolves.toEqual({ runId: "run-aborted", status: "cancelled" });
  });

  test("reports scheduler wait only when waiting on pending tasks", async () => {
    const waits = [];
    const task = { nodeId: "task-1", iteration: 0 };
    const driver = makeDriver({
      onSchedulerWait: (durationMs, context) => waits.push({ durationMs, context }),
      session: makeSession({
        taskCompleted: () => ({ _tag: "Finished", result: { runId: "run-1", status: "finished" } }),
      }),
    });
    driver.activeRunId = "run-1";
    driver.activeOptions = { input: {} };
    driver.settledTasks.push({
      key: "task-1::0",
      task,
      kind: "completed",
      output: "ready",
    });

    await driver.nextCompletionDecision();

    expect(waits).toEqual([]);

    let finishTask;
    const pendingTask = { nodeId: "task-2", iteration: 0 };
    driver.executeTask = () => new Promise((resolve) => {
      finishTask = resolve;
    });
    driver.startInflightTask(pendingTask, {
      runId: "run-1",
      options: { input: {} },
    });
    const decisionPromise = driver.nextCompletionDecision();
    await Promise.resolve();
    finishTask("done");
    await decisionPromise;

    expect(waits).toHaveLength(1);
    expect(waits[0].durationMs).toBeGreaterThan(0);
    expect(waits[0].context).toEqual({
      runId: "run-1",
      tasks: [pendingTask],
    });
  });
});
