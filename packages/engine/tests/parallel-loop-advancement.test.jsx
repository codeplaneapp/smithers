/** @jsxImportSource smithers-orchestrator */
/**
 * Regression test for https://github.com/smithersai/smithers/issues/267
 *
 * Loop iteration advancement used to require total quiescence: with any task
 * in flight (or pending) anywhere in the graph, the engine returned
 * await-trigger / schedule-retry before ever reaching the readyRalphs branch,
 * so independent parallel loops starved behind unrelated pipelines.
 */
import { describe, expect, test } from "bun:test";
import { Loop, Parallel, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("issue #267 – parallel loop advancement without quiescence", () => {
    test(
        "a ready loop keeps iterating while a sibling task is still in flight",
        async () => {
            const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
                tick: z.object({ n: z.number(), atMs: z.number() }),
                slow: z.object({ finishedAtMs: z.number() }),
            });
            const SLOW_MS = 4_000;
            const workflow = smithers((ctx) => {
                const ticks = ctx.outputs.tick ?? [];
                return (<Workflow name="parallel-loop-starvation-mre">
            <Parallel>
              <Loop id="fast-loop" until={ticks.length >= 3} maxIterations={5}>
                <Task id="tick" output={outputs.tick}>
                  {() => ({ n: (ctx.outputs.tick ?? []).length, atMs: Date.now() })}
                </Task>
              </Loop>
              <Task id="slow" output={outputs.slow}>
                {async () => {
                    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
                    return { finishedAtMs: Date.now() };
                }}
              </Task>
            </Parallel>
          </Workflow>);
            });
            await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "parallel-loop-starvation-mre" }));
            const ticks = await db.select().from(tables.tick);
            const slowRows = await db.select().from(tables.slow);
            expect(slowRows.length).toBe(1);
            expect(ticks.length).toBeGreaterThanOrEqual(3);
            // Without the fix, tick iterations 1+ only run after `slow`
            // completes; with it, every iteration lands while `slow` is still
            // sleeping.
            const lastTickAtMs = Math.max(...ticks.map((row) => row.atMs));
            expect(lastTickAtMs).toBeLessThan(slowRows[0].finishedAtMs);
            cleanup();
        },
        30_000,
    );

    test(
        "an unhandled task failure keeps precedence over further loop iterations (legacy engine)",
        async () => {
            const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
                tick: z.object({ n: z.number() }),
                boom: z.object({ ok: z.boolean() }),
            });
            const workflow = smithers((ctx) => (<Workflow name="loop-vs-failure-mre">
          <Parallel>
            <Loop id="fast-loop" until={false} maxIterations={5}>
              <Task id="tick" output={outputs.tick}>
                {() => ({ n: (ctx.outputs.tick ?? []).length })}
              </Task>
            </Loop>
            <Task id="boom" output={outputs.boom} noRetry>
              {() => {
                  throw new Error("boom");
              }}
            </Task>
          </Parallel>
        </Workflow>));
            process.env.SMITHERS_LEGACY_ENGINE = "1";
            let result;
            try {
                result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "loop-vs-failure-mre" }));
            }
            finally {
                delete process.env.SMITHERS_LEGACY_ENGINE;
            }
            expect(result.status).toBe("failed");
            // The ready loop must not keep iterating ahead of the failed task:
            // at most the iteration that was already in flight when `boom`
            // failed may land.
            const ticks = await db.select().from(tables.tick);
            expect(ticks.length).toBeLessThanOrEqual(2);
            cleanup();
        },
        30_000,
    );
});
