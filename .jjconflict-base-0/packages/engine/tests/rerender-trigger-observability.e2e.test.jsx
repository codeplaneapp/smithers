/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Parallel, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("per-completion rerender trigger observability", () => {
    test(
        "fast conditional work dispatches before a slow sibling finishes and records the task-finished frame trigger",
        async () => {
            const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
                fast: z.object({ finishedAtMs: z.number() }),
                afterFast: z.object({ dispatchedAtMs: z.number() }),
                slow: z.object({ finishedAtMs: z.number() }),
            });
            const frameEvents = [];
            const runId = "rerender-trigger-observability";
            const workflow = smithers((ctx) => {
                const fastRows = ctx.outputs.fast ?? [];
                return (<Workflow name="rerender-trigger-observability">
          <Parallel>
            <Task id="fast" output={outputs.fast}>
              {async () => {
                    await sleep(25);
                    return { finishedAtMs: Date.now() };
                }}
            </Task>
            {fastRows.length > 0 ? (<Task id="after-fast" output={outputs.afterFast}>
                {() => ({ dispatchedAtMs: Date.now() })}
              </Task>) : null}
            <Task id="slow" output={outputs.slow}>
              {async () => {
                    await sleep(750);
                    return { finishedAtMs: Date.now() };
                }}
            </Task>
          </Parallel>
        </Workflow>);
            });

            try {
                const result = await Effect.runPromise(runWorkflow(workflow, {
                    input: {},
                    runId,
                    onProgress: (event) => {
                        if (event.type === "FrameCommitted") {
                            frameEvents.push(event);
                        }
                    },
                }));

                expect(result.status).toBe("finished");
                const afterRows = await db.select().from(tables.afterFast);
                const slowRows = await db.select().from(tables.slow);
                expect(afterRows.length).toBe(1);
                expect(slowRows.length).toBe(1);
                expect(afterRows[0].dispatchedAtMs).toBeLessThan(slowRows[0].finishedAtMs);

                const fastCompletionFrame = frameEvents.find((event) => event.trigger?.nodeId === "fast");
                expect(fastCompletionFrame).toBeTruthy();
                expect(fastCompletionFrame.trigger.reason).toBe("task-finished");
            }
            finally {
                cleanup();
            }
        },
        30_000,
    );
});
