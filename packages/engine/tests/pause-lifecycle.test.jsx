/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Sequence, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
describe("graceful pause lifecycle", () => {
  test("pause request drains the in-flight task, parks the run paused, and leaves successors pending", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const adapter = new SmithersDb(db);
    let t1Completed = false;
    let t2Started = false;
    let t2Runs = 0;
    const workflow = smithers(() => (
      <Workflow name="pause-lifecycle">
        <Sequence>
          <Task id="t1" output={outputs.out}>
            {async () => {
              // Slow enough that the durable pause is detected by the run
              // supervisor (250ms poll) while t1 is still in-flight.
              await sleep(800);
              t1Completed = true;
              return { v: 1 };
            }}
          </Task>
          <Task id="t2" output={outputs.out}>
            {async () => {
              t2Started = true;
              t2Runs += 1;
              return { v: 2 };
            }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    // Start the run but do NOT await it: t1 is in-flight while we request a
    // durable pause directly on the run row (as `smithers pause` would).
    const runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "pause-run", maxConcurrency: 1 }));
    await sleep(150);
    for (let i = 0; i < 50 && !(await Effect.runPromise(adapter.getRun("pause-run"))); i++) {
      await sleep(20);
    }
    await Effect.runPromise(adapter.requestRunPause("pause-run", Date.now()));
    const result = await runPromise;
    expect(result.status).toBe("paused");
    const run = await Effect.runPromise(adapter.getRun("pause-run"));
    expect(run?.status).toBe("paused");
    // Parked resumably: no finish stamp, and the pause request + heartbeat are
    // cleared so a resume starts clean.
    expect(run?.finishedAtMs ?? null).toBeNull();
    expect(run?.pauseRequestedAtMs ?? null).toBeNull();
    expect(run?.heartbeatAtMs ?? null).toBeNull();
    // The in-flight t1 drained to completion (never aborted); the successor t2
    // stayed pending because pause stops scheduling new tasks.
    expect(t1Completed).toBe(true);
    expect(t2Started).toBe(false);
    // Resuming the parked run drives the remaining successor exactly once.
    const resumed = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "pause-run", resume: true }));
    expect(resumed.status).toBe("finished");
    expect(t2Started).toBe(true);
    expect(t2Runs).toBe(1);
    cleanup();
  });
});
