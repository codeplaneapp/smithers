/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Branch, Loop, Parallel, Sequence, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const COMPONENT_TIMEOUT_MS = 30_000;
/**
 * @param {string} name
 * @param {() => Promise<unknown>} fn
 */
function workflowTest(name, fn) {
  test(name, fn, COMPONENT_TIMEOUT_MS);
}
describe("Loop boundary modes", () => {
  workflowTest("return-last at the cap finishes the run with exactly maxIterations iterations", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      tick: z.object({ note: z.string() }),
      summary: z.object({ ticks: z.number() }),
    });
    const workflow = smithers((ctx) => (
      <Workflow name="loop-return-last-cap">
        <Sequence>
          <Loop id="drain" until={false} maxIterations={3} onMaxReached="return-last">
            <Task id="tick" output={outputs.tick}>
              {{ note: `tick-${ctx.iteration}` }}
            </Task>
          </Loop>
          <Task id="summary" output={outputs.summary}>
            {{ ticks: ctx.outputs("tick").length }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const tickRows = db
      .select()
      .from(tables.tick)
      .all()
      .sort((a, b) => a.iteration - b.iteration);
    expect(tickRows.map((row) => row.iteration)).toEqual([0, 1, 2]);
    const summaryRows = db.select().from(tables.summary).all();
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].ticks).toBe(3);
    cleanup();
  });
  workflowTest("maxIterations=1 with return-last runs the body exactly once", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      tick: z.object({ note: z.string() }),
    });
    const workflow = smithers((ctx) => (
      <Workflow name="loop-single-iteration">
        <Loop id="once" until={false} maxIterations={1} onMaxReached="return-last">
          <Task id="tick" output={outputs.tick}>
            {{ note: `tick-${ctx.iteration}` }}
          </Task>
        </Loop>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    const tickRows = db.select().from(tables.tick).all();
    expect(tickRows.map((row) => row.iteration)).toEqual([0]);
    cleanup();
  });
  workflowTest("until already true runs zero iterations and still finishes", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      tick: z.object({ note: z.string() }),
      summary: z.object({ ticks: z.number() }),
    });
    const workflow = smithers((ctx) => (
      <Workflow name="loop-zero-iterations">
        <Sequence>
          <Loop id="noop" until={true} maxIterations={5}>
            <Task id="tick" output={outputs.tick}>
              {{ note: "never" }}
            </Task>
          </Loop>
          <Task id="summary" output={outputs.summary}>
            {{ ticks: ctx.outputs("tick").length }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(db.select().from(tables.tick).all().length).toBe(0);
    const summaryRows = db.select().from(tables.summary).all();
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].ticks).toBe(0);
    cleanup();
  });
  workflowTest("onMaxReached=fail reports the loop id and cap in the error", async () => {
    const { Workflow, Task, smithers, outputs, cleanup } = createTestSmithers({
      tick: z.object({ note: z.string() }),
    });
    const workflow = smithers(() => (
      <Workflow name="loop-fail-error-shape">
        <Loop id="stuck" until={false} maxIterations={2} onMaxReached="fail">
          <Task id="tick" output={outputs.tick}>
            {{ note: "tick" }}
          </Task>
        </Loop>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RALPH_MAX_REACHED");
    const serialized = JSON.stringify(result.error);
    expect(serialized).toContain("stuck");
    expect(serialized).toContain("2");
    cleanup();
  });
});
describe("Branch else fallback through the engine", () => {
  workflowTest("if=false with no else finishes with zero rows and no stuck nodes", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      thenOut: z.object({ took: z.string() }),
      after: z.object({ done: z.boolean() }),
    });
    const workflow = smithers(() => (
      <Workflow name="branch-no-else">
        <Sequence>
          <Branch
            if={false}
            then={
              <Task id="then-task" output={outputs.thenOut}>
                {{ took: "then" }}
              </Task>
            }
          />
          <Task id="after" output={outputs.after}>
            {{ done: true }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(db.select().from(tables.thenOut).all().length).toBe(0);
    expect(db.select().from(tables.after).all().length).toBe(1);
    cleanup();
  });
});
describe("Parallel maxConcurrency=1", () => {
  workflowTest("serializes the group so tasks never overlap", async () => {
    const { Workflow, Task, smithers, outputs, cleanup } = createTestSmithers({
      slotA: z.object({ value: z.number() }),
      slotB: z.object({ value: z.number() }),
      slotC: z.object({ value: z.number() }),
    });
    let active = 0;
    let peak = 0;
    /**
     * @param {number} value
     */
    const occupySlot = async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { value };
    };
    const workflow = smithers(() => (
      <Workflow name="parallel-serialized">
        <Parallel maxConcurrency={1}>
          <Task id="a" output={outputs.slotA}>
            {() => occupySlot(1)}
          </Task>
          <Task id="b" output={outputs.slotB}>
            {() => occupySlot(2)}
          </Task>
          <Task id="c" output={outputs.slotC}>
            {() => occupySlot(3)}
          </Task>
        </Parallel>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(peak).toBe(1);
    cleanup();
  });
});
