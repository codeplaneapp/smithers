/** @jsxImportSource smithers-orchestrator */
/**
 * Cross-feature audit lane: ATTEMPT MACHINERY (retry-task / revert / attempt
 * budgets / rewind leases) x CHILD WORKFLOWS (<Subflow mode="childRun">).
 *
 * A non-technical user only ever says things like "run the review step again,
 * the answer was wrong" or "undo what the sub-workflow did". The shipped paths
 * for that are `retryTask()` + `runWorkflow({ resume: true })` (that is what
 * `smithers retry-task` does) and `revertToAttempt()` (`smithers revert`).
 * These tests drive those paths against a child run.
 *
 * Harness idioms copied from retry-task.e2e.test.jsx, revert.test.js,
 * rewindLock-concurrent.test.ts and subflow-childrun-multi-output.e2e.test.jsx:
 * temp-dir sqlite via createTestSmithers, scripted in-process compute fns, no
 * network, no paid models, no servers, no fixed ports.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { Sequence, Subflow } from "../../components/src/components/index.js";
import { __setRuntimeModuleLoader, extractFromHost } from "../../graph/src/dom/extract.js";
import { runWorkflow } from "../../engine/src/engine.js";
import { retryTask } from "../src/retry-task.js";
import { revertToAttempt } from "../src/revert.js";
import { acquireRewindLock } from "../src/acquireRewindLock.js";
import { createTestDb, createTestSmithers } from "../../smithers/tests/helpers.js";
import { ddl, schema } from "../../smithers/tests/schema.js";

const TIMEOUT_MS = 60_000;

function buildSmithers() {
  return createTestSmithers({
    expensiveOut: z.object({ value: z.number() }),
    flakyOut: z.object({ value: z.number() }),
    childOut: z.object({ value: z.number() }),
    subflowOut: z.object({ value: z.number() }),
    afterOut: z.object({ value: z.number() }),
  });
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function dumpRun(adapter, runId) {
  const run = await adapter.getRun(runId);
  const nodes = await adapter.listNodes(runId);
  const attempts = await adapter.listAttemptsForRun(runId);
  return {
    status: run?.status ?? null,
    workflowName: run?.workflowName ?? null,
    errorJson: run?.errorJson ?? null,
    nodes: nodes.map((node) => `${node.nodeId}=${node.state}`),
    attempts: attempts.map((a) => `${a.nodeId}#${a.attempt}=${a.state}`),
  };
}

describe("xcombo retry-task on a FINISHED <Subflow> child run", () => {
  test(
    "retrying a finished Subflow node re-runs the child instead of replaying its stale output",
    async () => {
      const { smithers, Workflow, Task, outputs, tables, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-retry-child">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  // Fresh work on every execution: the user is retrying
                  // because the previous answer was wrong.
                  return { value: childCalls };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-retry-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
            <Task id="after" output={outputs.afterOut} deps={{ review: outputs.subflowOut }} retries={0}>
              {(deps) => ({ value: deps.review.value * 10 })}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-retry-finished-subflow-run";
        const first = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(first.status).toBe("finished");
        expect(childCalls).toBe(1);
        const afterFirst = await db.select().from(tables.afterOut);

        // === the shipped "run that step again" path ===
        const reset = await retryTask(adapter, { runId, nodeId: "review" });
        expect(reset.success).toBe(true);
        expect(reset.resetNodes).toContain("review");

        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        const afterSecond = await db.select().from(tables.afterOut);
        const childRunId = `${runId}:child:review:0`;
        const diagnostics = JSON.stringify({
          resumed: resumed.status,
          childCalls,
          afterFirst,
          afterSecond,
          parent: await dumpRun(adapter, runId),
          child: await dumpRun(adapter, childRunId),
        });

        expect(resumed.status, diagnostics).toBe("finished");
        // The child MUST re-execute: retrying a step that produced a wrong
        // answer has to be able to produce a new answer.
        expect(childCalls, `child was never re-executed: ${diagnostics}`).toBe(2);
        expect(afterSecond[0]?.value, `downstream kept the stale child output: ${diagnostics}`).toBe(20);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "resetting the child run's node too (the only known recipe) does re-run a finished child",
    async () => {
      const { smithers, Workflow, Task, outputs, tables, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-retry-child-2">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  return { value: childCalls };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-retry-parent-2">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
            <Task id="after" output={outputs.afterOut} deps={{ review: outputs.subflowOut }} retries={0}>
              {(deps) => ({ value: deps.review.value * 10 })}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-retry-finished-subflow-deep-run";
        const first = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(first.status).toBe("finished");
        const childRunId = `${runId}:child:review:0`;

        // Reach INTO the child run (an id format the agent has to guess) and
        // reset its finished node, then reset the parent's Subflow node.
        const childReset = await retryTask(adapter, { runId: childRunId, nodeId: "work" });
        const parentReset = await retryTask(adapter, { runId, nodeId: "review", force: true });
        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        const afterSecond = await db.select().from(tables.afterOut);
        const diagnostics = JSON.stringify({
          childReset,
          parentReset,
          resumed: resumed.status,
          childCalls,
          afterSecond,
          parent: await dumpRun(adapter, runId),
          child: await dumpRun(adapter, childRunId),
        });
        expect(childReset.success, diagnostics).toBe(true);
        expect(parentReset.success, diagnostics).toBe(true);
        expect(resumed.status, diagnostics).toBe("finished");
        expect(childCalls, diagnostics).toBe(2);
        expect(afterSecond[0]?.value, diagnostics).toBe(20);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo retry-task on a FAILED <Subflow> child run", () => {
  test(
    "preserves completed child work and its output while retrying only failed work",
    async () => {
      const { smithers, Workflow, Task, outputs, tables, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let expensiveCalls = 0;
        let flakyCalls = 0;
        let tailCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-surgical-child">
              <Sequence>
                <Task id="expensive" output={outputs.expensiveOut} retries={0}>
                  {() => {
                    expensiveCalls += 1;
                    return { value: 40 };
                  }}
                </Task>
                <Task id="flaky" output={outputs.flakyOut} retries={0}>
                  {() => {
                    flakyCalls += 1;
                    if (flakyCalls === 1) throw new Error("retry me");
                    return { value: 42 };
                  }}
                </Task>
                <Task id="tail" output={outputs.childOut} retries={0}>
                  {() => {
                    tailCalls += 1;
                    return { value: 43 };
                  }}
                </Task>
              </Sequence>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-surgical-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-surgical-child-reset";
        expect((await Effect.runPromise(runWorkflow(parent, { input: {}, runId }))).status).toBe("failed");
        const childRunId = `${runId}:child:review:0`;
        const outputBefore = await db.select().from(tables.expensiveOut);
        expect((await adapter.listNodes(childRunId)).map(({ nodeId, state }) => `${nodeId}=${state}`).sort()).toEqual(
          ["expensive=finished", "flaky=failed", "tail=pending"],
        );

        expect((await retryTask(adapter, { runId, nodeId: "review" })).success).toBe(true);
        expect((await adapter.getNode(childRunId, "expensive", 0))?.state).toBe("finished");
        expect(await db.select().from(tables.expensiveOut)).toEqual(outputBefore);

        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        expect({
          status: resumed.status,
          expensiveCalls,
          flakyCalls,
          tailCalls,
          expensiveOutput: await db.select().from(tables.expensiveOut),
        }).toEqual({
          status: "finished",
          expensiveCalls: 1,
          flakyCalls: 2,
          tailCalls: 1,
          expensiveOutput: outputBefore,
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "cascades the surgical reset through nested child runs",
    async () => {
      const { smithers, Workflow, Task, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let grandchildCalls = 0;
        const grandchild = smithers(
          () => (
            <Workflow name="xcombo-retry-grandchild">
              <Task id="flaky" output={outputs.childOut} retries={0}>
                {() => {
                  grandchildCalls += 1;
                  if (grandchildCalls === 1) throw new Error("nested retry me");
                  return { value: 42 };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const child = smithers(
          () => (
            <Workflow name="xcombo-retry-middle-child">
              <Subflow id="nested" mode="childRun" output={outputs.subflowOut} workflow={grandchild} retries={0} />
            </Workflow>
          ),
          { output: outputs.subflowOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-retry-nested-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
          </Workflow>
        ));
        const runId = "xcombo-recursive-child-reset";
        expect((await Effect.runPromise(runWorkflow(parent, { input: {}, runId }))).status).toBe("failed");

        expect((await retryTask(adapter, { runId, nodeId: "review" })).success).toBe(true);
        const resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId, resume: true }));
        const grandchildRunId = `${runId}:child:review:0:child:nested:0`;
        expect({
          status: resumed.status,
          grandchildCalls,
          grandchildStatus: (await adapter.getRun(grandchildRunId))?.status,
        }).toEqual({
          status: "finished",
          grandchildCalls: 2,
          grandchildStatus: "finished",
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo `smithers retry-task --run-id <childRunId>`", () => {
  test(
    "retrying a node inside the child run does not let the parent's graph overwrite the child run",
    async () => {
      const { smithers, Workflow, Task, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-cli-child">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  return { value: childCalls };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-cli-parent">
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={0} />
            <Task id="after" output={outputs.afterOut} deps={{ review: outputs.subflowOut }} retries={0}>
              {(deps) => ({ value: deps.review.value * 10 })}
            </Task>
          </Workflow>
        ));
        const runId = "xcombo-cli-retry-child-run";
        const first = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        expect(first.status).toBe("finished");
        const childRunId = `${runId}:child:review:0`;

        // Exactly what `smithers retry-task -r <childRunId> -n work` does: reset
        // the child's node, then resume "the workflow" — which for the CLI is
        // always the PARENT workflow file, under the CHILD's run id.
        const reset = await retryTask(adapter, { runId: childRunId, nodeId: "work" });
        expect(reset.success).toBe(true);
        /** @type {any} */
        let resumed;
        /** @type {any} */
        let thrown = null;
        try {
          resumed = await Effect.runPromise(runWorkflow(parent, { input: {}, runId: childRunId, resume: true }));
        } catch (error) {
          thrown = error;
        }
        const childAfter = await dumpRun(adapter, childRunId);
        const grandchild = await adapter.getRun(`${childRunId}:child:review:0`);
        const diagnostics = JSON.stringify({
          resumed: resumed?.status ?? null,
          thrown: thrown ? String(thrown?.message ?? thrown) : null,
          childAfter,
          grandchildRunId: grandchild?.runId ?? null,
          childCalls,
        });
        // Either the mismatch is refused, or the child run keeps its own graph.
        // What must NOT happen: the parent's nodes appearing inside the child
        // run, which corrupts every later retry/revert/diff of that child.
        const leaked = childAfter.nodes.filter((entry) => !entry.startsWith("work="));
        expect(leaked, `parent graph leaked into the child run: ${diagnostics}`).toEqual([]);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo attempt budgets across the parent/child boundary", () => {
  test(
    "a Subflow node's own retries re-run the child's failed work",
    async () => {
      const { smithers, Workflow, Task, outputs, db, cleanup } = buildSmithers();
      const adapter = new SmithersDb(db);
      try {
        let childCalls = 0;
        const child = smithers(
          () => (
            <Workflow name="xcombo-budget-child">
              <Task id="work" output={outputs.childOut} retries={0}>
                {() => {
                  childCalls += 1;
                  if (childCalls < 3) throw new Error(`child transient boom #${childCalls}`);
                  return { value: childCalls };
                }}
              </Task>
            </Workflow>
          ),
          { output: outputs.childOut },
        );
        const parent = smithers(() => (
          <Workflow name="xcombo-budget-parent">
            {/* The parent budgets 3 attempts for the whole subflow step. */}
            <Subflow id="review" mode="childRun" output={outputs.subflowOut} workflow={child} retries={2} />
          </Workflow>
        ));
        const runId = "xcombo-subflow-attempt-budget-run";
        const result = await Effect.runPromise(runWorkflow(parent, { input: {}, runId }));
        const childRunId = `${runId}:child:review:0`;
        const diagnostics = JSON.stringify({
          status: result.status,
          childCalls,
          parent: await dumpRun(adapter, runId),
          child: await dumpRun(adapter, childRunId),
        });
        // 3 parent attempts must mean 3 child executions of the failing task.
        expect(childCalls, `parent retries never reached the child: ${diagnostics}`).toBe(3);
        expect(result.status, diagnostics).toBe("finished");
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("xcombo <Subflow> inside <Worktree>: which checkout does the child run in", () => {
  test("the child run receives the worktree as its rootDir, not the parent checkout", async () => {
    const { smithers, Workflow, outputs, cleanup } = buildSmithers();
    /** @type {any} */
    let captured = null;
    // Official test seam: keep the heavy engine module out of the graph's
    // <Subflow> computeFn so the options it hands the child are observable.
    const restoreLoader = __setRuntimeModuleLoader(async () => ({
      executeChildWorkflow: async (_parentWorkflow, opts) => {
        captured = opts;
        return { runId: "captured-child", status: "finished", output: [] };
      },
    }));
    try {
      const child = smithers(() => <Workflow name="wt-child" />, { output: outputs.childOut });
      const parentRoot = mkdtempSync(join(tmpdir(), "xcombo-parent-root-"));
      const worktreePath = join(parentRoot, ".smithers", "worktrees", "lane");
      mkdirSync(worktreePath, { recursive: true });
      const root = {
        kind: "element",
        tag: "smithers:workflow",
        props: {},
        rawProps: { name: "wt-parent" },
        children: [
          {
            kind: "element",
            tag: "smithers:worktree",
            props: {},
            rawProps: { id: "lane", path: worktreePath },
            children: [
              {
                kind: "element",
                tag: "smithers:subflow",
                props: {},
                rawProps: {
                  id: "review",
                  output: outputs.subflowOut,
                  mode: "childRun",
                  __smithersSubflowMode: "childRun",
                  __smithersSubflowWorkflow: child,
                  __smithersSubflowInput: { topic: "x" },
                },
                children: [],
              },
            ],
          },
        ],
      };
      const extracted = extractFromHost(root, { baseRootDir: parentRoot, workflowPath: join(parentRoot, "wf.tsx") });
      const desc = extracted.tasks.find((task) => task.nodeId === "review");
      expect(desc).toBeDefined();
      // The graph knows which checkout the lane owns.
      expect(desc?.worktreePath).toBe(worktreePath);

      await desc?.computeFn?.({});
      // ...and the child must run in it. Otherwise every agent inside the
      // child run edits the PARENT checkout, and a later `smithers revert` of
      // a child attempt restores the wrong tree.
      const diagnostics = JSON.stringify({
        childRootDir: captured?.rootDir ?? null,
        parentRoot,
        worktreePath,
        descWorktreePath: desc?.worktreePath ?? null,
      });
      expect(captured?.rootDir, diagnostics).toBe(worktreePath);
    } finally {
      restoreLoader();
      cleanup();
    }
  });
});

describe("xcombo rewind lease scoping across a parent/child pair", () => {
  test("a child-run revert is excluded while the parent holds a time-travel lease on the same checkout", async () => {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    /** @type {any} */
    let lock = null;
    try {
      const parentRunId = "lease-parent-run";
      const childRunId = `${parentRunId}:child:review:0`;
      // Both runs share ONE checkout: that is what <Subflow> does today.
      const sharedCheckout = mkdtempSync(join(tmpdir(), "xcombo-shared-checkout-"));
      await adapter.insertRun({
        runId: parentRunId,
        workflowName: "parent",
        status: "finished",
        createdAtMs: Date.now(),
      });
      await adapter.insertRun({
        runId: childRunId,
        workflowName: "child",
        status: "finished",
        createdAtMs: Date.now(),
        parentRunId,
      });
      await adapter.insertAttempt({
        runId: childRunId,
        nodeId: "work",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: Date.now(),
        jjPointer: "child-pointer-1",
        jjCwd: sharedCheckout,
      });
      lock = await acquireRewindLock(adapter, parentRunId);
      expect(lock).not.toBeNull();

      const result = await revertToAttempt(adapter, {
        runId: childRunId,
        nodeId: "work",
        iteration: 0,
        attempt: 1,
        force: true,
      });
      const diagnostics = JSON.stringify(result);
      // A revert inside the child mutates the same files the parent's
      // in-flight time travel is restoring: it must be refused, not raced.
      expect(result.success, diagnostics).toBe(false);
      expect(result.error ?? "", diagnostics).toMatch(/already running|another time-travel/i);
    } finally {
      await lock?.release?.().catch?.(() => undefined);
      cleanup();
    }
  });
});
