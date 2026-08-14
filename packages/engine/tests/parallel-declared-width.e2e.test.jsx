/** @jsxImportSource smthrs */
import { afterEach, describe, expect, test } from "bun:test";
import { Workflow, Task, Parallel } from "smthrs";
// The unit under test is THIS package's engine: the declared-width derivation
// lives in ../src/engine.js + ../src/slotGovernor.js, so import it relatively
// instead of through the package barrel.
import { runWorkflow } from "../src/index.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";

const originalCeilingEnv = process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING;
afterEach(() => {
  if (originalCeilingEnv === undefined) {
    delete process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING;
  } else {
    process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = originalCeilingEnv;
  }
});

describe("declared Parallel width derives the default run concurrency", () => {
  test("Parallel maxConcurrency={64} runs 64 wide with no --max-concurrency flag (not capped at the default 4 or the auto-raise ceiling)", async () => {
    // Pin the demand auto-raise ceiling to its default of 16 so this test
    // proves the DECLARED width (not an inflated ambient ceiling) is what
    // lets the run exceed 16.
    process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = "16";
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const adapter = new SmithersDb(db);
    const runId = "declared-width-64";
    const WIDTH = 64;
    let running = 0;
    let peak = 0;
    let barrierReached = false;
    /** @type {() => void} */
    let releaseBarrier = () => {};
    const barrier = new Promise((resolveBarrier) => {
      releaseBarrier = () => resolveBarrier(undefined);
    });
    const barrierDeadline = sleep(8000);
    const workflow = smithers(() => (
      <Workflow name="declared-width-64">
        <Parallel maxConcurrency={64}>
          {Array.from({ length: WIDTH }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                running++;
                if (running > peak) peak = running;
                if (running === WIDTH) {
                  barrierReached = true;
                  releaseBarrier();
                }
                // All 64 tasks must be in flight AT ONCE for the barrier
                // to open. If the engine capped the run at the default 4
                // or the auto-raise ceiling of 16, the barrier never opens
                // and the shared deadline releases every current and future
                // task so the assertions below fail cleanly instead of
                // timing out one queued batch at a time.
                await Promise.race([barrier, barrierDeadline]);
                running--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    // No maxConcurrency flag here: the engine must derive the default from
    // the graph's declared <Parallel maxConcurrency={64}>.
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    expect(r.status).toBe("finished");
    expect(barrierReached).toBe(true);
    expect(peak).toBe(WIDTH);
    // The derived default is NOT a pin: resume re-derives it from the
    // graph instead of restoring a persisted cap.
    const config = JSON.parse((await adapter.getRun(runId))?.configJson ?? "{}");
    expect(config.maxConcurrency).toBe(4);
    expect(config.maxConcurrencyPinned).toBeUndefined();
    cleanup();
  }, 20_000);

  test("Parallel subtreeConcurrency={24} runs 24 wide with no --max-concurrency flag (not capped at the auto-raise ceiling)", async () => {
    // subtreeConcurrency caps concurrent child SUBTREES, not tasks — but it
    // is still a declared width, so the run must get at least that many
    // task slots instead of stalling at the ceiling of 16.
    process.env.SMITHERS_AUTO_MAX_CONCURRENCY_CEILING = "16";
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const WIDTH = 24;
    let running = 0;
    let peak = 0;
    let barrierReached = false;
    /** @type {() => void} */
    let releaseBarrier = () => {};
    const barrier = new Promise((resolveBarrier) => {
      releaseBarrier = () => resolveBarrier(undefined);
    });
    const barrierDeadline = sleep(4000);
    const workflow = smithers(() => (
      <Workflow name="declared-subtree-width-24">
        <Parallel subtreeConcurrency={24}>
          {Array.from({ length: WIDTH }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                running++;
                if (running > peak) peak = running;
                if (running === WIDTH) {
                  barrierReached = true;
                  releaseBarrier();
                }
                // Same barrier shape as the maxConcurrency case: a run
                // capped at 4 or at the ceiling of 16 never opens it; the
                // shared deadline drains the queue so the assertions fail
                // cleanly.
                await Promise.race([barrier, barrierDeadline]);
                running--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const r = await Effect.runPromise(
      runWorkflow(workflow, {
        input: {},
        runId: "declared-subtree-width-24",
      }),
    );
    expect(r.status).toBe("finished");
    expect(barrierReached).toBe(true);
    expect(peak).toBe(WIDTH);
    cleanup();
  }, 12_000);

  test("an explicit maxConcurrency pin beats the declared subtree width", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    let current = 0;
    let peak = 0;
    const workflow = smithers(() => (
      <Workflow name="pin-beats-declared-subtree-width">
        <Parallel subtreeConcurrency={32}>
          {Array.from({ length: 8 }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                current++;
                if (current > peak) peak = current;
                await sleep(120);
                current--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));
    expect(r.status).toBe("finished");
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    cleanup();
  });

  test("an explicit maxConcurrency pin beats the declared Parallel width", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    let current = 0;
    let peak = 0;
    const workflow = smithers(() => (
      <Workflow name="pin-beats-declared-width">
        <Parallel maxConcurrency={8}>
          {Array.from({ length: 8 }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                current++;
                if (current > peak) peak = current;
                await sleep(120);
                current--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));
    expect(r.status).toBe("finished");
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    cleanup();
  });
});
