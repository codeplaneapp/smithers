/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Poller, runWorkflow } from "smthrs";
import { createTestSmithers, sleep } from "./helpers.js";
import { z } from "zod";
import { Effect } from "effect";
const COMPONENT_TIMEOUT_MS = 30_000;
/**
 * A Poller paces itself with a durable <Timer>, so a run with a non-trivial
 * `intervalMs` parks as `waiting-timer` between attempts instead of sleeping
 * in-process. In production the gateway timer sweep resumes it; here we drive
 * the resumes ourselves, exactly as timer.test.jsx does.
 * @param {any} workflow
 * @returns {Promise<any>}
 */
async function pollToCompletion(workflow) {
  let result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
  for (let attempt = 0; attempt < 40 && result.status === "waiting-timer"; attempt++) {
    await sleep(25);
    result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: result.runId, resume: true }));
  }
  return result;
}
describe("Poller with an agent check", () => {
  test(
    "an AgentLike check polls through the real engine until satisfied",
    async () => {
      const { Workflow, smithers, outputs, tables, db, cleanup } = createTestSmithers({
        check: z.object({ satisfied: z.boolean() }),
      });
      /** @type {any[]} */
      const calls = [];
      const checkAgent = {
        id: "status-checker",
        tools: {},
        generate: async (args) => {
          calls.push(args);
          const satisfied = calls.length >= 2;
          return {
            output: { satisfied },
            text: JSON.stringify({ satisfied }),
            response: { messages: [] },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="poller-agent-check">
          <Poller
            id="deploy"
            check={checkAgent}
            checkOutput={outputs.check}
            maxAttempts={4}
            intervalMs={50}
            backoff="exponential"
            onTimeout="fail"
          >
            Check whether the deploy finished.
          </Poller>
        </Workflow>
      ));
      const result = await pollToCompletion(workflow);
      expect(result.status).toBe("finished");
      // The check ran as an agent task (not compute): the agent was invoked
      // once per loop iteration with the authored prompt children.
      expect(calls.length).toBe(2);
      for (const call of calls) {
        expect(JSON.stringify(call)).toContain("Check whether the deploy finished.");
      }
      const rows = db
        .select()
        .from(tables.check)
        .all()
        .sort((a, b) => a.iteration - b.iteration);
      expect(rows.map((row) => Boolean(row.satisfied))).toEqual([false, true]);
      cleanup();
    },
    COMPONENT_TIMEOUT_MS,
  );
  test(
    "an agent check that never satisfies fails loudly at maxAttempts with onTimeout=fail",
    async () => {
      const { Workflow, smithers, outputs, cleanup } = createTestSmithers({
        check: z.object({ satisfied: z.boolean() }),
      });
      let generateCalls = 0;
      const neverReady = {
        id: "never-ready",
        tools: {},
        generate: async () => {
          generateCalls += 1;
          return {
            output: { satisfied: false },
            text: JSON.stringify({ satisfied: false }),
            response: { messages: [] },
          };
        },
      };
      const workflow = smithers(() => (
        <Workflow name="poller-agent-exhaustion">
          <Poller
            id="deploy"
            check={neverReady}
            checkOutput={outputs.check}
            maxAttempts={2}
            intervalMs={10}
            onTimeout="fail"
          />
        </Workflow>
      ));
      const result = await pollToCompletion(workflow);
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("RALPH_MAX_REACHED");
      expect(generateCalls).toBe(2);
      cleanup();
    },
    COMPONENT_TIMEOUT_MS,
  );
});
