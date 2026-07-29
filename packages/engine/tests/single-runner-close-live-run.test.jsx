/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Task,
  Workflow,
  closeSingleRunnerRuntime,
  reopenSingleRunnerRuntime,
  runWorkflow,
} from "smithers-orchestrator";
import { __singleRunnerInternals as I } from "@smithers-orchestrator/engine/effect/single-runner";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

/**
 * #1378, against a REAL run and a real cluster runtime.
 *
 * The hole both investigations flagged: during driver retry backoff a run is
 * very much alive but `workerExecutions` is empty, so an "are any dispatches
 * in flight" guard would happily dispose the runtime out from under it. The
 * run lease is what closes that hole, and this pins it.
 */
describe("closeSingleRunnerRuntime against a live run", () => {
  test("rejects during retry backoff, and succeeds once the run settles", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    let attempts = 0;
    let backoffObserved = false;
    const flakyAgent = {
      id: "flaky-agent",
      tools: {},
      generate: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("first attempt fails on purpose");
        }
        return { output: { value: attempts } };
      },
    };
    const workflow = smithers(() => (
      <Workflow name="close-during-backoff">
        <Task
          id="flaky"
          output={outputs.outputA}
          agent={flakyAgent}
          retries={1}
          retryPolicy={{ backoff: "fixed", initialDelayMs: 2_000 }}
        >
          retry once with a long backoff
        </Task>
      </Workflow>
    ));
    ensureSmithersTables(db);
    let runPromise;
    try {
      runPromise = Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "close-backoff-run" }));
      // Wait for the backoff window: the first attempt has failed, no
      // dispatch is registered, and the second attempt has not started.
      for (let i = 0; i < 400; i++) {
        if (attempts === 1 && I.activeDispatchLeases.size === 0 && I.workerExecutions.size === 0) {
          backoffObserved = true;
          break;
        }
        await sleep(10);
      }
      expect(backoffObserved).toBe(true);
      await expect(closeSingleRunnerRuntime()).rejects.toMatchObject({
        code: "SINGLE_RUNNER_BUSY",
        details: { runIds: ["close-backoff-run"] },
      });
      // The runtime was left usable, so the retry attempt still runs.
      const result = await runPromise;
      expect(result.status).toBe("finished");
      expect(attempts).toBe(2);
    } finally {
      await Promise.allSettled([runPromise].filter(Boolean));
      cleanup();
    }
    // Settled run, so the close now goes through, and reopen makes the
    // runtime usable again for the rest of the suite.
    await closeSingleRunnerRuntime();
    expect(I.getSingleRunnerStateForTest()).toBe("closed");
    reopenSingleRunnerRuntime();
    expect(I.getSingleRunnerStateForTest()).toBe("idle");
  }, 60_000);

  test("two sequential runs survive a close and reopen between them", async () => {
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const agent = {
      id: "echo-agent",
      tools: {},
      generate: async () => ({ output: { value: 1 } }),
    };
    const workflow = smithers(() => (
      <Workflow name="close-between-runs">
        <Task id="echo" output={outputs.outputA} agent={agent}>
          echo
        </Task>
      </Workflow>
    ));
    ensureSmithersTables(db);
    try {
      const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "close-between-a" }));
      expect(first.status).toBe("finished");
      await closeSingleRunnerRuntime();
      // Terminal by default: the next run must not silently resurrect the
      // cluster daemons during a shutdown.
      const blocked = await Effect.runPromise(
        Effect.result(runWorkflow(workflow, { input: {}, runId: "close-between-blocked" })),
      );
      expect(blocked._tag).toBe("Failure");
      expect(blocked.failure.code).toBe("SINGLE_RUNNER_CLOSED");
      reopenSingleRunnerRuntime();
      const second = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "close-between-b" }));
      expect(second.status).toBe("finished");
    } finally {
      cleanup();
    }
  }, 60_000);
});
