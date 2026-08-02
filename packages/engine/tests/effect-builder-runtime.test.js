import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Duration, Effect, Schedule, Schema } from "effect";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { Smithers, __builderInternals as I } from "../src/effect/builder.js";

const inputSchema = Schema.Struct({
  repo: Schema.String,
  sha: Schema.String,
});

const outputSchema = Schema.Struct({
  value: Schema.String,
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-builder-"));
  return {
    filename: join(dir, "smithers.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
      } catch (error) {
        // Windows can keep SQLite files locked briefly after close. The
        // test assertions have already completed; don't fail on teardown lag.
        if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(error?.code)) {
          throw error;
        }
      }
    },
  };
}

function key(handle, iteration = 0) {
  return `${handle.tableName}:${handle.id}:${iteration}`;
}

function row(handle, payload, iteration = 0) {
  return {
    runId: "run",
    nodeId: handle.id,
    iteration,
    payload,
  };
}

function makeCtx(rows = {}, overrides = {}) {
  return {
    runId: "ctx-run",
    iteration: 0,
    outputMaybe(tableName, query) {
      return rows[`${tableName}:${query.nodeId}:${query.iteration}`];
    },
    ...overrides,
  };
}

function makeRuntime(db, overrides = {}) {
  return {
    runId: "runtime-run",
    stepId: "step",
    attempt: 2,
    iteration: 0,
    signal: new AbortController().signal,
    db,
    heartbeat: () => {},
    lastHeartbeat: { cursor: "last" },
    ...overrides,
  };
}

describe("effect builder internals", () => {
  test("creates legacy builder handles and derives identifier, retry and duration metadata", () => {
    const builder = I.createBuilder("scope");
    const dep = builder.step("dep", {
      output: outputSchema,
      retry: { maxAttempts: 3, backoff: "linear", initialDelay: "2s" },
      timeout: "1.5m",
      cache: { key: "dep" },
    });
    const step = builder.step("Needs Value", {
      output: outputSchema,
      needs: { dep },
      retryPolicy: { backoff: "fixed", initialDelayMs: 10 },
      timeout: 42.8,
    });
    const approval = builder.approval("Gate!", {
      needs: { dep },
      request: ({ dep }) => ({ title: dep.value, summary: "summary" }),
      onDeny: "continue",
    });

    expect(I.sanitizeIdentifier("Scope.Value / With Spaces")).toBe("scope_value_with_spaces");
    expect(I.sanitizeIdentifier("!!!")).toBe("node");
    expect(I.makeTableName("A/B")).toBe("smithers_a_b");
    expect(dep).toMatchObject({
      kind: "step",
      id: "scope.dep",
      localId: "dep",
      tableKey: "scope_dep",
      tableName: "smithers_scope_dep",
      retries: 2,
      retryPolicy: { backoff: "linear", initialDelayMs: 2000 },
      timeoutMs: 90_000,
      cache: { key: "dep" },
    });
    expect(step.retryPolicy).toEqual({ backoff: "fixed", initialDelayMs: 10 });
    expect(step.timeoutMs).toBe(42);
    expect(approval).toMatchObject({
      kind: "approval",
      id: "scope.Gate!",
      tableKey: "scope_gate",
      onDeny: "continue",
      retries: 0,
      timeoutMs: null,
    });
    expect(builder.sequence(dep, step)).toMatchObject({ kind: "sequence", children: [dep, step] });
    expect(builder.parallel(dep, step, { maxConcurrency: "4" })).toMatchObject({
      kind: "parallel",
      children: [dep, step],
      maxConcurrency: 4,
    });
    expect(builder.parallel(dep).maxConcurrency).toBeUndefined();
    expect(
      builder.loop({
        id: "retry",
        children: step,
        until: () => true,
        maxIterations: 3,
        onMaxReached: "return-last",
      }),
    ).toMatchObject({
      kind: "loop",
      id: "scope.retry",
      children: step,
      maxIterations: 3,
      onMaxReached: "return-last",
    });
    expect(builder.loop({ children: step, until: () => true }).id).toBeUndefined();
    expect(builder.match(dep, { when: () => true, then: () => step, else: () => approval })).toMatchObject({
      kind: "match",
      source: dep,
      then: step,
      else: approval,
    });
    expect(
      builder.component(
        "child",
        {
          buildWithPrefix: (prefix, params) => ({ kind: "branch", prefix, params }),
        },
        { enabled: true },
      ),
    ).toEqual({
      kind: "branch",
      prefix: "scope.child",
      params: { enabled: true },
    });

    for (const node of [
      dep,
      approval,
      builder.sequence(dep),
      builder.parallel(dep),
      builder.loop({ children: dep, until: () => true }),
      builder.match(dep, { when: () => true, then: () => step }),
      { kind: "branch" },
      { kind: "worktree" },
    ]) {
      expect(I.isBuilderNode(node)).toBe(true);
    }
    expect(I.isBuilderNode(null)).toBe(false);
    expect(I.isBuilderNode({ kind: "unknown" })).toBe(false);

    expect(I.durationToMs(null)).toBeNull();
    expect(I.durationToMs("3h")).toBe(10_800_000);
    expect(I.durationToMs(`${"9".repeat(400)}ms`)).toBeNull();
    expect(I.durationToMs(-2)).toBe(0);
    expect(I.durationToMs(Duration.millis(12))).toBe(12);
    expect(I.durationToMs("later")).toBeNull();
    expect(I.deriveRetryPolicy(null)).toBeUndefined();
    expect(I.deriveRetryPolicy({ backoff: "custom" })).toBeUndefined();
    expect(I.deriveRetryPolicy({ initialDelay: "5ms" })).toEqual({ backoff: undefined, initialDelayMs: 5 });
    expect(I.deriveRetryCount(null)).toBe(0);
    expect(I.deriveRetryCount(2.8)).toBe(2);
    expect(I.deriveRetryCount({ maxAttempts: 4 })).toBe(3);
    expect(I.deriveRetryCount(Schedule.recurs(2))).toBe(2);
    expect(I.deriveRetryCount(Schedule.forever)).toBe(100);
    expect(I.deriveRetryCount("bad")).toBe(0);
    expect(I.deriveRetryCount(Symbol("bad"))).toBe(0);
  });

  test("reads handle values, builds contexts, resolves effects and renders runtime nodes", async () => {
    const builder = I.createBuilder();
    const dep = builder.step("dep", { output: outputSchema });
    const step = builder.step("step", {
      output: outputSchema,
      needs: { dep },
      skipIf: ({ dep }) => dep.value === "dep-value",
    });
    const throwingSkip = builder.step("throwing", {
      output: outputSchema,
      skipIf: () => {
        throw new Error("skip failed");
      },
    });
    const gate = builder.approval("gate", {
      needs: { dep },
      request: ({ dep }) => ({ title: `Approve ${dep.value}`, summary: "Need approval" }),
    });
    dep.loopId = "loop";
    step.loopId = "loop";
    const ctx = makeCtx(
      {
        [key(dep, 2)]: row(dep, { value: "dep-value" }, 2),
      },
      {
        iterations: { loop: 2 },
      },
    );
    const runtime = makeRuntime(null, {
      runId: "runtime-run",
      stepId: "runtime-step",
      attempt: 5,
      iteration: 7,
    });

    expect(I.resolveHandleIteration(dep, ctx)).toBe(2);
    expect(I.resolveHandleIteration(builder.step("plain", { output: outputSchema }), ctx)).toBe(0);
    expect(I.stripPersistedKeys(row(dep, { value: "payload" }))).toEqual({ value: "payload" });
    expect(I.stripPersistedKeys({ runId: "r", nodeId: "n", iteration: 0, value: "rest" })).toEqual({ value: "rest" });
    expect(I.readHandleMaybe(dep, ctx)).toEqual({ value: "dep-value" });
    expect(I.readHandleMaybe(dep, makeCtx())).toBeUndefined();
    expect(() => I.readHandle(dep, makeCtx())).toThrow('Missing output for step "dep"');
    expect(I.readHandle(dep, ctx)).toEqual({ value: "dep-value" });

    expect(I.buildUserContext(step, ctx, { repo: "r", sha: "s" }, runtime)).toMatchObject({
      dep: { value: "dep-value" },
      input: { repo: "r", sha: "s" },
      executionId: "runtime-run",
      stepId: "step",
      attempt: 5,
      iteration: 7,
      lastHeartbeat: { cursor: "last" },
    });
    expect(I.buildUserContext(step, ctx, { repo: "r", sha: "s" })).toMatchObject({
      executionId: "ctx-run",
      iteration: 2,
      lastHeartbeat: null,
    });
    expect(I.buildNeedsContext({ dep }, ctx, { repo: "r", sha: "s" }, runtime)).toMatchObject({
      dep: { value: "dep-value" },
      executionId: "runtime-run",
      stepId: "runtime-step",
      attempt: 5,
      iteration: 7,
      loop: { iteration: 8 },
    });
    expect(I.buildNeedsContext(undefined, makeCtx({}, { iteration: 3 }), {}, undefined)).toMatchObject({
      executionId: "ctx-run",
      stepId: "",
      attempt: 1,
      iteration: 3,
      loop: { iteration: 4 },
    });

    expect(await I.resolveEffectResult("direct", Context.empty(), runtime.signal)).toBe("direct");
    expect(await I.resolveEffectResult(Promise.resolve("promise"), Context.empty(), runtime.signal)).toBe("promise");
    expect(await I.resolveEffectResult(Effect.succeed("effect"), Context.empty(), runtime.signal)).toBe("effect");
    expect(
      await I.resolveEffectResult(Promise.resolve(Effect.succeed("promise-effect")), Context.empty(), runtime.signal),
    ).toBe("promise-effect");
    expect(I.evaluateSkip(builder.step("no-skip", { output: outputSchema }), ctx, {})).toBe(false);
    expect(I.evaluateSkip(step, ctx, {})).toBe(true);
    expect(I.evaluateSkip(throwingSkip, ctx, {})).toBe(false);

    const stepElement = I.renderNode(step, ctx, { repo: "r", sha: "s" }, Context.empty());
    expect(stepElement.props).toMatchObject({
      id: "step",
      skipIf: true,
      needsApproval: false,
      needs: { dep: "dep" },
      dependsOn: ["dep"],
    });
    const gateElement = I.renderNode(gate, ctx, {}, Context.empty());
    expect(gateElement.props).toMatchObject({
      id: "gate",
      needsApproval: true,
      approvalMode: "decision",
      approvalOnDeny: "fail",
      label: "Approve dep-value",
      meta: { requestSummary: "Need approval" },
    });
    expect(I.renderNode(gate, makeCtx(), {}, Context.empty()).props.label).toBeUndefined();

    const sequence = I.renderNode(builder.sequence(dep, step), ctx, {}, Context.empty());
    expect(sequence.props.children).toHaveLength(2);
    const parallel = I.renderNode(builder.parallel(dep, step, { maxConcurrency: 2 }), ctx, {}, Context.empty());
    expect(parallel.props.maxConcurrency).toBe(2);
    const loop = builder.loop({
      id: "loop",
      children: step,
      until: ({ dep }) => dep?.value === "dep-value",
      maxIterations: 3,
      onMaxReached: "return-last",
    });
    loop.handles = [dep];
    const loopElement = I.renderNode(loop, ctx, { repo: "r", sha: "s" }, Context.empty());
    expect(loopElement.props).toMatchObject({
      id: "loop",
      until: true,
      maxIterations: 3,
      onMaxReached: "return-last",
    });
    const branch = {
      kind: "branch",
      needs: { dep },
      condition: ({ dep }) => dep?.value === "dep-value",
      then: step,
      else: gate,
    };
    expect(I.renderNode(branch, ctx, {}, Context.empty()).props.if).toBe(true);
    expect(I.renderNode({ ...branch, condition: () => false }, ctx, {}, Context.empty()).props.if).toBe(false);
    const worktree = {
      kind: "worktree",
      id: "wt",
      path: "scratch/wt",
      branch: "feature",
      needs: { dep },
      skipIf: ({ dep }) => dep?.value === "dep-value",
      children: step,
    };
    expect(I.renderNode(worktree, ctx, {}, Context.empty()).props).toMatchObject({
      id: "wt",
      path: "scratch/wt",
      branch: "feature",
      skipIf: true,
    });
    const match = builder.match(dep, {
      when: ({ value }) => value === "dep-value",
      then: () => step,
      else: () => gate,
    });
    expect(I.renderNode(match, ctx, {}, Context.empty()).props.if).toBe(true);
    expect(I.renderNode(match, makeCtx(), {}, Context.empty()).props.if).toBe(false);
    expect(I.renderNode({ kind: "unknown" }, ctx, {}, Context.empty())).toBeNull();
  });

  test("executes step and approval handles inside a task runtime", async () => {
    const temp = tempDb();
    const runtime = I.createBuilderDb(temp.filename, []);
    try {
      ensureSmithersTables(runtime.db);
      const adapter = new SmithersDb(runtime.db);
      await adapter.insertOrUpdateApproval({
        runId: "runtime-run",
        nodeId: "gate",
        iteration: 0,
        status: "approved",
        requestedAtMs: Date.now() - 10,
        decidedAtMs: Date.now(),
        note: "ship it",
        decidedBy: "alice",
      });
      const builder = I.createBuilder();
      const step = builder.step("step", {
        output: outputSchema,
        run: () => Effect.succeed({ value: "from-effect" }),
      });
      const gate = builder.approval("gate", {
        request: () => ({ title: "Approve" }),
      });
      const taskRuntime = makeRuntime(runtime.db);

      const stepResult = await withTaskRuntime(taskRuntime, () =>
        I.executeStepHandle(step, makeCtx(), {}, Context.empty()),
      );
      expect(stepResult).toEqual({ value: "from-effect" });
      const gateResult = await withTaskRuntime(taskRuntime, () =>
        I.executeStepHandle(gate, makeCtx(), {}, Context.empty()),
      );
      expect(gateResult).toEqual({
        approved: true,
        note: "ship it",
        decidedBy: "alice",
        decidedAt: null,
      });
    } finally {
      runtime.sqlite.close();
      temp.cleanup();
    }
  });

  test("collects, annotates, persists and extracts builder graph results", async () => {
    const builder = I.createBuilder();
    const first = builder.step("first", { output: outputSchema });
    const second = builder.step("second", { output: outputSchema });
    const third = builder.step("third", { output: outputSchema });
    const gate = builder.approval("gate", { request: () => ({ title: "gate" }) });
    const sequence = builder.sequence(first, second);
    const parallel = builder.parallel(first, second);
    const match = builder.match(first, {
      when: ({ value }) => value === "latest",
      then: () => second,
      else: () => third,
    });
    const branch = {
      kind: "branch",
      needs: { first },
      condition: ({ first }) => first?.value === "latest",
      then: second,
      else: third,
    };
    const worktree = {
      kind: "worktree",
      id: "wt",
      path: "scratch/wt",
      branch: "feature",
      children: second,
    };
    const loop = builder.loop({ id: "loop", children: sequence, until: () => true });
    const root = builder.parallel(sequence, match, branch, worktree, loop, gate);

    expect(I.collectHandles(root).map((handle) => handle.id)).toEqual([
      "first",
      "second",
      "second",
      "third",
      "second",
      "third",
      "second",
      "first",
      "second",
      "gate",
    ]);
    expect(() => I.assertUniqueHandleIds([first, second])).not.toThrow();
    expect(() => I.assertUniqueHandleIds([first, first])).toThrow('Duplicate step id "first"');
    expect(I.annotateLoops(root).map((handle) => handle.id)).toContain("gate");
    expect(first.loopId).toBe("loop");
    const nested = builder.loop({
      id: "outer",
      children: builder.loop({
        id: "inner",
        children: builder.step("inner-step", { output: outputSchema }),
        until: () => true,
      }),
      until: () => true,
    });
    expect(() => I.annotateLoops(nested)).toThrow("Nested builder loops are not supported");
    expect(I.applyPrefixId("", "a")).toBe("a");
    expect(I.applyPrefixId("scope", "a")).toBe("scope.a");
    expect(I.applyPrefixId("scope", undefined)).toBeUndefined();

    const temp = tempDb();
    const runtime = I.createBuilderDb(temp.filename, [first, second, third]);
    try {
      await runtime.db.insert(first.table).values([
        { runId: "run", nodeId: first.id, iteration: 0, payload: { value: "old" } },
        { runId: "run", nodeId: first.id, iteration: 1, payload: { value: "latest" } },
      ]);
      await runtime.db.insert(second.table).values({
        runId: "run",
        nodeId: second.id,
        iteration: 0,
        payload: { value: "second" },
      });
      await runtime.db.insert(third.table).values({
        runId: "run",
        nodeId: third.id,
        iteration: 0,
        payload: { value: "third" },
      });

      expect(runtime.schema).toHaveProperty("first");
      expect(await I.readLatestHandleResult(runtime.db, "run", first)).toEqual({ value: "latest" });
      expect(await I.readLatestHandleResult(runtime.db, "missing", first)).toBeUndefined();
      expect(await I.extractResult(first, runtime.db, "run", {})).toEqual({ value: "latest" });
      expect(await I.extractResult(builder.sequence(), runtime.db, "run", {})).toBeUndefined();
      expect(await I.extractResult(sequence, runtime.db, "run", {})).toEqual({ value: "second" });
      expect(await I.extractResult(parallel, runtime.db, "run", {})).toEqual([
        { value: "latest" },
        { value: "second" },
      ]);
      expect(await I.extractResult(loop, runtime.db, "run", {})).toEqual({ value: "second" });
      expect(await I.extractResult(match, runtime.db, "run", {})).toEqual({ value: "second" });
      expect(
        await I.extractResult(
          {
            ...match,
            when: () => false,
          },
          runtime.db,
          "run",
          {},
        ),
      ).toEqual({ value: "third" });
      expect(await I.extractResult(branch, runtime.db, "run", { repo: "r", sha: "s" })).toEqual({ value: "second" });
      expect(
        await I.extractResult(
          {
            ...branch,
            condition: () => false,
          },
          runtime.db,
          "run",
          {},
        ),
      ).toEqual({ value: "third" });
      expect(await I.extractResult(worktree, runtime.db, "run", {})).toEqual({ value: "second" });
    } finally {
      runtime.sqlite.close();
      temp.cleanup();
    }

    expect(I.normalizeExecutionError({ status: "failed", error: new Error("boom") })).toBeInstanceOf(Error);
    expect(I.normalizeExecutionError({ status: "failed", error: "bad" }).message).toContain("bad");
    expect(I.normalizeExecutionError({ status: "cancelled" }).message).toContain('status "cancelled"');
  });

  test("compiles raw graph expressions and rejects unknown expressions", () => {
    const factory = I.makeFactory();
    const step = factory.step("base", { output: outputSchema });
    const approval = factory.approval("gate", { request: () => ({ title: "gate" }) });
    const sequence = factory.sequence(step, approval);
    const parallel = factory.parallel(step, approval, { maxConcurrency: 2 });
    const branch = factory.branch({ condition: () => true, needs: { step }, then: approval });
    const loop = factory.loop({ id: "loop", children: step, until: () => true });
    const worktree = factory.worktree({ id: "wt", path: "scratch", children: step });
    const scoped = factory.scope("scope", step);

    expect(I.isWorkflowGraph(step)).toBe(true);
    expect(I.isWorkflowGraph({})).toBe(false);
    expect(I.compileNeeds(undefined, "", new Map())).toBeUndefined();
    expect(I.compileNeeds({ step }, "", new Map()).step.id).toBe("base");
    expect(I.compileGraph(sequence).children.map((node) => node.id)).toEqual(["base", "gate"]);
    expect(I.compileGraph(parallel).maxConcurrency).toBe(2);
    expect(I.compileGraph(branch).needs.step.id).toBe("base");
    expect(I.compileGraph(loop).id).toBe("loop");
    expect(I.compileGraph(worktree).path).toBe("scratch");
    expect(I.compileGraph(scoped).id).toBe("scope.base");
    const memo = new Map();
    expect(I.compileGraph(step, "", memo)).toBe(I.compileGraph(step, "", memo));
    expect(() => I.compileGraph(I.makeGraph({ _tag: "Unknown" }))).toThrow("Unknown graph expression");
  });
});

describe("Smithers.workflow execute", () => {
  test("executes a finished builder workflow and extracts the final output", async () => {
    const temp = tempDb();
    try {
      const G = Smithers.workflow({ name: "builder-finished", input: inputSchema });
      const step = G.step("build", {
        output: outputSchema,
        run: ({ input }) => ({ value: `${input.repo}@${input.sha}` }),
      });
      const wf = G.from(step);
      const result = await Effect.runPromise(
        wf
          .execute(
            {
              repo: "smithers",
              sha: "abc123",
            },
            {
              runId: "builder-finished-run",
            },
          )
          .pipe(Effect.provide(Smithers.sqlite({ filename: temp.filename }))),
      );
      expect(result).toEqual({ value: "smithers@abc123" });
    } finally {
      temp.cleanup();
    }
  }, 30_000);

  test("returns waiting approval results from builder workflow execution", async () => {
    const temp = tempDb();
    try {
      const G = Smithers.workflow({ name: "builder-approval", input: inputSchema });
      const wf = G.from(
        G.approval("gate", {
          request: () => ({ title: "Approve" }),
        }),
      );
      const result = await Effect.runPromise(
        wf
          .execute(
            {
              repo: "smithers",
              sha: "abc123",
            },
            {
              runId: "builder-approval-run",
            },
          )
          .pipe(Effect.provide(Smithers.sqlite({ filename: temp.filename }))),
      );
      expect(result.status).toBe("waiting-approval");
      expect(result.runId).toBe("builder-approval-run");
    } finally {
      temp.cleanup();
    }
  }, 30_000);

  test("normalizes failed builder workflow execution", async () => {
    const temp = tempDb();
    try {
      const G = Smithers.workflow({ name: "builder-failed", input: inputSchema });
      const wf = G.from(
        G.step("bad", {
          output: outputSchema,
          run: () => {
            throw new Error("builder exploded");
          },
        }),
      );
      await expect(
        Effect.runPromise(
          wf
            .execute(
              {
                repo: "smithers",
                sha: "abc123",
              },
              {
                runId: "builder-failed-run",
              },
            )
            .pipe(Effect.provide(Smithers.sqlite({ filename: temp.filename }))),
        ),
      ).rejects.toThrow('status "failed"');
    } finally {
      temp.cleanup();
    }
  }, 30_000);
});
