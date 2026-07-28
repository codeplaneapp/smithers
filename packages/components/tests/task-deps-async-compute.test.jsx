/** @jsxImportSource smithers-orchestrator */
/**
 * Regression tests for #1415.
 *
 * A `<Task deps={...}>` with a function child used to fall into the *static*
 * branch: the callback ran at render time and its return value became the
 * static payload. For an `async (deps) => ...` child — the exact form the docs
 * show — that payload was an unresolved Promise, `stripAutoColumns` reduced it
 * to `{}`, and the engine claimed completion without ever awaiting the work.
 *
 * deps + function children now route through the compute branch, so the
 * callback runs exactly once, at execution time, and is awaited.
 */
import { describe, expect, test } from "bun:test";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { renderFrame, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("Task deps + async compute children (#1415)", () => {
  test("an async (deps) => value child is awaited and persists its real payload", async () => {
    const { smithers, Workflow, Task, outputs, tables, db, cleanup } = createTestSmithers({
      source: z.object({ items: z.array(z.string()) }),
      derived: z.object({ count: z.number(), first: z.string() }),
    });
    const workflow = smithers(() => (
      <Workflow name="deps-async-compute">
        <Task id="source" output={outputs.source}>
          {{ items: ["alpha", "beta", "gamma"] }}
        </Task>
        <Task id="derived" output={outputs.derived} deps={{ source: outputs.source }}>
          {async (deps) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { count: deps.source.items.length, first: deps.source.items[0] };
          }}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "deps-async-compute" }));
    expect(result.status).toBe("finished");
    const rows = db.select().from(tables.derived).all();
    expect(rows).toHaveLength(1);
    // Before the fix this row was empty ({} after stripAutoColumns).
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.first).toBe("alpha");
    cleanup();
  }, 20_000);

  test("a downstream task reads the awaited value of an async deps callback", async () => {
    const { smithers, Workflow, Task, outputs, tables, db, cleanup } = createTestSmithers({
      source: z.object({ items: z.array(z.string()) }),
      derived: z.object({ count: z.number(), first: z.string() }),
      report: z.object({ summary: z.string() }),
    });
    const workflow = smithers(() => (
      <Workflow name="deps-async-compute-chain">
        <Task id="source" output={outputs.source}>
          {{ items: ["alpha", "beta"] }}
        </Task>
        <Task id="derived" output={outputs.derived} deps={{ source: outputs.source }}>
          {async (deps) => ({ count: deps.source.items.length, first: deps.source.items[0] })}
        </Task>
        <Task id="report" output={outputs.report} deps={{ derived: outputs.derived }}>
          {(deps) => ({ summary: `${deps.derived.count} items starting with ${deps.derived.first}` })}
        </Task>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "deps-async-compute-chain" }));
    expect(result.status).toBe("finished");
    const rows = db.select().from(tables.report).all();
    expect(rows[0]?.summary).toBe("2 items starting with alpha");
    cleanup();
  }, 20_000);

  test("the async callback runs exactly once, at execution time and not at render", async () => {
    const { smithers, Workflow, Task, outputs, cleanup } = createTestSmithers({
      source: z.object({ message: z.string() }),
      derived: z.object({ echoed: z.string() }),
    });
    /** @type {string[]} */
    const calls = [];
    const workflow = smithers(() => (
      <Workflow name="deps-async-once">
        <Task id="source" output={outputs.source}>
          {{ message: "ready" }}
        </Task>
        <Task id="derived" output={outputs.derived} deps={{ source: outputs.source }}>
          {async (deps) => {
            calls.push(deps.source.message);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { echoed: deps.source.message };
          }}
        </Task>
      </Workflow>
    ));

    // Rendering a frame with the dep already satisfied must not invoke the
    // callback: rendering happens many times per run, so a render-time call
    // would re-run side effects on every frame.
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "deps-async-once-frame",
          iteration: 0,
          input: {},
          outputs: {
            source: [{ runId: "deps-async-once-frame", nodeId: "source", iteration: 0, message: "ready" }],
          },
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const derived = frame.tasks.find((task) => task.nodeId === "derived");
    expect(derived?.kind).toBe("compute");
    expect(derived?.staticPayload).toBeUndefined();
    expect(calls).toEqual([]);

    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "deps-async-once" }));
    expect(result.status).toBe("finished");
    // Exactly once — the old static branch invoked it on every render frame.
    expect(calls).toEqual(["ready"]);
    cleanup();
  }, 20_000);

  test("a sync (deps) => value child preserves render-time compatibility", async () => {
    const { smithers, Workflow, Task, outputs, tables, db, cleanup } = createTestSmithers({
      source: z.object({ message: z.string() }),
      derived: z.object({ echoed: z.string() }),
    });
    /** @type {string[]} */
    const calls = [];
    const workflow = smithers(() => (
      <Workflow name="deps-sync-compute">
        <Task id="source" output={outputs.source}>
          {{ message: "still fine" }}
        </Task>
        <Task id="derived" output={outputs.derived} deps={{ source: outputs.source }}>
          {(deps) => {
            calls.push(deps.source.message);
            return { echoed: deps.source.message };
          }}
        </Task>
      </Workflow>
    ));
    const frame = await Effect.runPromise(
      renderFrame(
        workflow,
        new SmithersCtx({
          runId: "deps-sync-compute-frame",
          iteration: 0,
          input: {},
          outputs: {
            source: [{ runId: "deps-sync-compute-frame", nodeId: "source", iteration: 0, message: "still fine" }],
          },
          zodToKeyName: workflow.zodToKeyName,
        }),
      ),
    );
    const derived = frame.tasks.find((task) => task.nodeId === "derived");
    expect(derived?.kind).toBe("static");
    expect(derived?.staticPayload).toEqual({ echoed: "still fine" });
    expect(calls).toEqual(["still fine"]);

    calls.length = 0;
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "deps-sync-compute" }));
    expect(result.status).toBe("finished");
    const rows = db.select().from(tables.derived).all();
    expect(rows[0]?.echoed).toBe("still fine");
    // A workflow may render more than once; compatibility means each render
    // still evaluates the sync callback before its static task executes.
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(["still fine"]));
    cleanup();
  }, 20_000);
});
