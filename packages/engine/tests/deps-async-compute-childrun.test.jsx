/** @jsxImportSource smthrs */
/**
 * Regression tests for #1415.
 *
 * 1. A `<Task deps>` whose async callback launches a child run must be awaited
 *    before the parent claims completion. Under the old static routing the
 *    parent persisted `{}` and finished while the child run was still in
 *    flight.
 * 2. A payload that is still a thenable when the engine goes to persist it must
 *    fail loudly and non-retryably, never silently become `{}`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb, Subflow, Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

describe("deps + async compute callbacks (#1415)", () => {
  test(
    "a child run launched from an async deps callback is awaited before the parent completes",
    async () => {
      const parent = createTestSmithers({
        source: z.object({ topic: z.string() }),
        fanout: z.object({ childRunId: z.string(), childStatus: z.string(), headline: z.string() }),
      });
      // The nested workflows get their own database so their child-run engine
      // does not contend with the parent engine's sqlite file.
      const child = createTestSmithers({
        draft: z.object({ headline: z.string() }),
      });
      /** @type {string[]} */
      const order = [];
      try {
        const leafWorkflow = child.smithers(
          (ctx) => (
            <Workflow name="async-deps-subflow-leaf">
              <Task id="draft" output={child.outputs.draft}>
                {async () => {
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  order.push("subflow-child-task");
                  return { headline: `child covered ${ctx.input.topic ?? "nothing"}` };
                }}
              </Task>
            </Workflow>
          ),
          { output: child.outputs.draft },
        );
        const childWorkflow = child.smithers(
          (ctx) => (
            <Workflow name="async-deps-child">
              <Subflow
                id="draft-subflow"
                workflow={leafWorkflow}
                input={{ topic: ctx.input.topic }}
                output={child.outputs.draft}
              />
            </Workflow>
          ),
          { output: child.outputs.draft },
        );
        const parentWorkflow = parent.smithers(() => (
          <Workflow name="async-deps-parent">
            <Task id="source" output={parent.outputs.source}>
              {{ topic: "child runs" }}
            </Task>
            <Task id="fanout" output={parent.outputs.fanout} deps={{ source: parent.outputs.source }}>
              {async (deps) => {
                const childResult = await Effect.runPromise(
                  runWorkflow(childWorkflow, { input: { topic: deps.source.topic } }),
                );
                order.push("subflow-child-run-awaited");
                const childRows = child.db.select().from(child.tables.draft).all();
                const subflowRow = childRows.find(
                  (row) => row.runId === childResult.runId && row.nodeId === "draft-subflow",
                );
                return {
                  childRunId: childResult.runId,
                  childStatus: childResult.status,
                  headline: String(subflowRow?.headline ?? ""),
                };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(parentWorkflow, { input: {} }));
        order.push("parent-finished");
        expect(result.status).toBe("finished");

        const rows = parent.db.select().from(parent.tables.fanout).all();
        expect(rows).toHaveLength(1);
        // Before the fix this row was empty: the parent claimed completion with
        // the child run's Promise unresolved.
        expect(rows[0]?.childStatus).toBe("finished");
        expect(rows[0]?.headline).toBe("child covered child runs");
        expect(rows[0]?.childRunId).toBeTruthy();
        expect(order).toEqual(["subflow-child-task", "subflow-child-run-awaited", "parent-finished"]);
      } finally {
        parent.cleanup();
        child.cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a thenable static payload fails loudly and is not retried (bridge-managed path)",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        thing: z.object({ value: z.string() }),
      });
      try {
        const workflow = smithers(() => (
          <Workflow name="thenable-static-bridge">
            <Task id="pending" output={outputs.thing} retries={2}>
              {Promise.resolve({ value: "never awaited" })}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "thenable-static-bridge" }));
        expect(result.status).toBe("failed");
        const serialized = JSON.stringify(result.error);
        expect(serialized).toContain("INVALID_OUTPUT");
        expect(serialized).toContain("Promise");
        expect(serialized).toContain("pending");
        const adapter = new SmithersDb(db);
        const attempts = await Effect.runPromise(adapter.listAttempts(result.runId, "pending", 0));
        // Non-retryable: retrying would produce the same unresolved Promise.
        expect(attempts).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a thenable static payload fails loudly on the legacy execution path",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers({
        thing: z.object({ value: z.string() }),
      });
      try {
        // `sideEffect` opts the task out of the bridge-managed static path, so
        // this exercises the guard inside legacyExecuteTask.
        const workflow = smithers(() => (
          <Workflow name="thenable-static-legacy">
            <Task id="pending" output={outputs.thing} sideEffect retries={2}>
              {Promise.resolve({ value: "never awaited" })}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "thenable-static-legacy" }));
        expect(result.status).toBe("failed");
        const serialized = JSON.stringify(result.error);
        expect(serialized).toContain("INVALID_OUTPUT");
        expect(serialized).toContain("Promise");
        const adapter = new SmithersDb(db);
        const attempts = await Effect.runPromise(adapter.listAttempts(result.runId, "pending", 0));
        expect(attempts).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
