/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Sequence, SmithersDb, Task, Timer, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";

const END_TO_END_TIMEOUT_MS = 30_000;

describe("dependency-gated timers through the real engine (#545)", () => {
  test("a downstream timer is not anchored while its dependencies are unmet", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers({
      out: z.object({ v: z.number() }),
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="timer-dep-gate">
          <Sequence>
            <Timer id="t1" duration="1h" />
            <Task id="a" output={outputs.out}>
              {() => ({ v: 1 })}
            </Task>
            <Timer id="t2" duration="10m" />
            <Task id="b" output={outputs.out}>
              {() => ({ v: 2 })}
            </Task>
          </Sequence>
        </Workflow>
      ));

      const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      // The run parks on t1; "a" (and therefore t2) hasn't run yet.
      expect(first.status).toBe("waiting-timer");

      const adapter = new SmithersDb(db);
      const t1Node = await adapter.getNode(first.runId, "t1", 0);
      expect(t1Node?.state).toBe("waiting-timer");

      // t2 depends transitively on "a", which hasn't run — the deferred-state
      // bridge must not have anchored t2's clock or created any attempt/node
      // row for it while the run is still parked on t1 (#545).
      expect(await adapter.getNode(first.runId, "t2", 0)).toBeUndefined();
      expect(await adapter.listAttempts(first.runId, "t2", 0)).toHaveLength(0);
    } finally {
      cleanup();
    }
  }, END_TO_END_TIMEOUT_MS);
});
