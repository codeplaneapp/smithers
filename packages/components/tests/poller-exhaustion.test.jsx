/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Poller, runWorkflow } from "smithers-orchestrator";
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
describe("Poller exhaustion", () => {
  workflowTest("onTimeout=return-last finishes the run with the last unsatisfied check", async () => {
    const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      check: z.object({ satisfied: z.boolean(), observedAtAttempt: z.number() }),
      summary: z.object({ attempts: z.number(), satisfied: z.boolean() }),
    });
    let calls = 0;
    const workflow = smithers((ctx) => {
      const checks = ctx.outputs("check");
      const latest = ctx.latest("check", "deploy-check");
      return (
        <Workflow name="poller-return-last-exhausted">
          <Sequence>
            <Poller
              id="deploy"
              check={() => {
                calls += 1;
                return { satisfied: false, observedAtAttempt: calls };
              }}
              checkOutput={outputs.check}
              maxAttempts={2}
              intervalMs={1}
              onTimeout="return-last"
            />
            <Task id="summary" output={outputs.summary}>
              {{
                attempts: checks.length,
                satisfied: latest?.satisfied ?? false,
              }}
            </Task>
          </Sequence>
        </Workflow>
      );
    });
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(calls).toBe(2);
    const checkRows = db.select().from(tables.check).all();
    expect(checkRows.length).toBe(2);
    expect(checkRows.every((row) => row.satisfied === false)).toBe(true);
    const summaryRows = db.select().from(tables.summary).all();
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].attempts).toBe(2);
    expect(summaryRows[0].satisfied).toBe(false);
    cleanup();
  });
  workflowTest("maxAttempts=1 with onTimeout=fail fails after a single check", async () => {
    const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup } = createTestSmithers({
      check: z.object({ satisfied: z.boolean(), observedAtAttempt: z.number() }),
      summary: z.object({ attempts: z.number() }),
    });
    let calls = 0;
    const workflow = smithers((ctx) => (
      <Workflow name="poller-single-attempt-fail">
        <Sequence>
          <Poller
            id="deploy"
            check={() => {
              calls += 1;
              return { satisfied: false, observedAtAttempt: calls };
            }}
            checkOutput={outputs.check}
            maxAttempts={1}
            intervalMs={1}
            onTimeout="fail"
          />
          <Task id="summary" output={outputs.summary}>
            {{ attempts: ctx.outputs("check").length }}
          </Task>
        </Sequence>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("RALPH_MAX_REACHED");
    expect(calls).toBe(1);
    expect(db.select().from(tables.check).all().length).toBe(1);
    expect(db.select().from(tables.summary).all().length).toBe(0);
    cleanup();
  });
});
