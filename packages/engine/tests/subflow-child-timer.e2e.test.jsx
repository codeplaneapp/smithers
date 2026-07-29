/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { Sequence, Task, Timer, Workflow, runWorkflow } from "smithers-orchestrator";
import { Subflow } from "@smithers-orchestrator/components/components/index";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

function runInTestRoot(workflow, dbPath, options) {
  return Effect.runPromise(runWorkflow(workflow, { ...options, rootDir: dirname(dbPath) }));
}

describe("<Subflow childRun> + child Timer", () => {
  test("parks the parent durably and resumes after the child timer", async () => {
    const harness = createTestSmithers({
      childResult: z.object({ done: z.boolean() }),
      subflowResult: z.object({ done: z.boolean() }),
    });
    const { smithers, outputs, db, dbPath, cleanup } = harness;
    try {
      const child = smithers(
        () => (
          <Workflow name="timer-child">
            <Sequence>
              <Timer id="hold" duration="50ms" />
              <Task id="done" output={outputs.childResult}>
                {{ done: true }}
              </Task>
            </Sequence>
          </Workflow>
        ),
        { output: outputs.childResult },
      );
      const parent = smithers(
        () => (
          <Workflow name="timer-parent">
            <Subflow id="child" mode="childRun" output={outputs.subflowResult} workflow={child} retries={0} />
          </Workflow>
        ),
        { output: outputs.subflowResult },
      );

      const first = await runInTestRoot(parent, dbPath, { input: {} });
      expect(first.status).toBe("waiting-timer");

      const adapter = new SmithersDb(db);
      const attempts = await adapter.listAttempts(first.runId, "child", 0);
      const waiting = attempts.find((attempt) => attempt.state === "waiting-timer");
      const firesAtMs = JSON.parse(waiting?.metaJson ?? "{}")?.timer?.firesAtMs;
      expect(Number.isFinite(firesAtMs)).toBe(true);
      expect(firesAtMs).toBeGreaterThan(Date.now());

      await sleep(Math.max(0, firesAtMs - Date.now() + 25));
      const resumed = await runInTestRoot(parent, dbPath, {
        input: {},
        runId: first.runId,
        resume: true,
      });
      expect(resumed.status).toBe("finished");
      expect(resumed.output).toEqual([expect.objectContaining({ done: true })]);
    } finally {
      cleanup();
    }
  }, 15_000);
});
