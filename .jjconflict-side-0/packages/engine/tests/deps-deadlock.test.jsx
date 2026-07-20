/** @jsxImportSource smithers-orchestrator */
/**
 * Regression tests for dependency resolution and deadlock detection:
 *
 *  1. An in-loop task can resolve a dep on an out-of-loop task across the loop
 *     boundary (the iteration-equality filter used to drop it, unmounting the
 *     task on every iteration >= 1 and livelocking the run).
 *  2. A `deps` key that maps to a node id no task produces no longer silently
 *     skips the task and finishes — the run fails loudly with a diagnostic.
 *  3. A task blocked on a non-existent `dependsOn` id no longer busy-loops
 *     forever with no error — the run fails with a deadlock diagnostic.
 */
import { describe, expect, test } from "bun:test";
import { Loop, Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

describe("deps resolution + deadlock detection", () => {
    test("in-loop task resolves an out-of-loop dep across the loop boundary", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
            config: z.object({ region: z.string() }),
            step: z.object({ used: z.string() }),
        });
        const workflow = smithers((ctx) => {
            const ranTwice = ctx.iterationCount("step", "step") >= 2;
            return (<Workflow name="loop-cross-boundary-deps">
          <Task id="config" output={outputs.config}>
            {{ region: "us-east" }}
          </Task>
          <Loop id="work-loop" until={ranTwice} maxIterations={4}>
            <Task id="step" output={outputs.step} needs={{ config: "config" }} deps={{ config: outputs.config }}>
              {(deps) => ({ used: deps.config.region })}
            </Task>
          </Loop>
        </Workflow>);
        });
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId: "loop-cross-boundary-deps",
        }));
        expect(result.status).toBe("finished");
        const stepRows = db
            .select()
            .from(tables.step)
            .all()
            .map((r) => ({ iteration: r.iteration, used: r.used }))
            .sort((a, b) => a.iteration - b.iteration);
        // The in-loop task resolved the out-of-loop config on every iteration,
        // including iteration >= 1 — the case the equality filter used to drop.
        expect(stepRows.length).toBeGreaterThanOrEqual(2);
        expect(stepRows[1]).toEqual({ iteration: 1, used: "us-east" });
        cleanup();
    }, 20_000);
    test("a deps key with no matching producer fails loudly instead of silently skipping", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            source: z.object({ message: z.string() }),
            report: z.object({ text: z.string() }),
        });
        // The dep key "summary" is treated as the upstream task id, but the
        // producer's id is "parse". Without a needs remap the dep never resolves,
        // so "report" defers forever. It must fail rather than finish without it.
        const workflow = smithers(() => (<Workflow name="deps-phantom">
        <Task id="parse" output={outputs.source}>
          {{ message: "hi" }}
        </Task>
        <Task id="report" output={outputs.report} deps={{ summary: outputs.source }}>
          {(deps) => ({ text: deps.summary.message })}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId: "deps-phantom",
        }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("report");
        expect(JSON.stringify(result.error)).toContain("needs={{");
        cleanup();
    }, 20_000);
    test("a task blocked on a non-existent dependsOn id fails with a deadlock diagnostic", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            source: z.object({ message: z.string() }),
        });
        const workflow = smithers(() => (<Workflow name="dangling-dependson">
        <Task id="orphan" output={outputs.source} dependsOn={["ghost"]}>
          {{ message: "hi" }}
        </Task>
      </Workflow>));
        const result = await Effect.runPromise(runWorkflow(workflow, {
            input: {},
            runId: "dangling-dependson",
        }));
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result.error)).toContain("ghost");
        expect(JSON.stringify(result.error)).toContain("no such task");
        cleanup();
    }, 20_000);
});
