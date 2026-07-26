/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Workflow, Task, Parallel, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
describe("slot governor auto-raise", () => {
  test("run without an explicit maxConcurrency raises past the default cap of 4", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    let current = 0;
    let peak = 0;
    const workflow = smithers(() => (
      <Workflow name="auto-raise">
        <Parallel>
          {Array.from({ length: 8 }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                current++;
                if (current > peak) peak = current;
                await sleep(150);
                current--;
                return { v: i };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    // No maxConcurrency here: the engine defaults to 4 and the governor is
    // free to raise the cap to the observed demand of 8.
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(r.status).toBe("finished");
    expect(peak).toBeGreaterThan(4);
    expect(peak).toBeLessThanOrEqual(8);
    cleanup();
  });
  test("an explicit --max-concurrency pin survives resume without the flag", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const adapter = new SmithersDb(db);
    const runId = "resume-keeps-pin";
    const seeded = smithers(() => (
      <Workflow name="resume-keeps-pin">
        <Task id="seed" output={outputs.out}>
          {{ v: 0 }}
        </Task>
      </Workflow>
    ));
    const first = await Effect.runPromise(runWorkflow(seeded, { input: {}, runId, maxConcurrency: 2 }));
    expect(first.status).toBe("finished");
    const launchConfig = JSON.parse((await adapter.getRun(runId))?.configJson ?? "{}");
    expect(launchConfig.maxConcurrency).toBe(2);
    expect(launchConfig.maxConcurrencyPinned).toBe(true);
    // Resume WITHOUT the flag — exactly how the supervisor and gateway
    // re-enter a run — into a workflow grown by 8 fresh parallel tasks:
    // the restored pin must keep the governor explicit, so peak
    // concurrency stays at 2 instead of auto-raising toward 8.
    let current = 0;
    let peak = 0;
    const grown = smithers(() => (
      <Workflow name="resume-keeps-pin">
        <Task id="seed" output={outputs.out}>
          {{ v: 0 }}
        </Task>
        <Parallel>
          {Array.from({ length: 8 }, (_, i) => (
            <Task key={`t${i}`} id={`t${i}`} output={outputs.out}>
              {async () => {
                current++;
                if (current > peak) peak = current;
                await sleep(120);
                current--;
                return { v: i + 1 };
              }}
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const resumed = await Effect.runPromise(runWorkflow(grown, { input: {}, runId, resume: true }));
    expect(resumed.status).toBe("finished");
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    const resumedConfig = JSON.parse((await adapter.getRun(runId))?.configJson ?? "{}");
    expect(resumedConfig.maxConcurrency).toBe(2);
    expect(resumedConfig.maxConcurrencyPinned).toBe(true);
    cleanup();
  });
  test("an auto run never persists a pin, so resume stays auto", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    const adapter = new SmithersDb(db);
    const runId = "resume-stays-auto";
    const workflow = smithers(() => (
      <Workflow name="resume-stays-auto">
        <Task id="seed" output={outputs.out}>
          {{ v: 0 }}
        </Task>
      </Workflow>
    ));
    const r = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }));
    expect(r.status).toBe("finished");
    const config = JSON.parse((await adapter.getRun(runId))?.configJson ?? "{}");
    expect(config.maxConcurrency).toBe(4);
    expect(config.maxConcurrencyPinned).toBeUndefined();
    cleanup();
  });
});
