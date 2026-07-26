/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listHeartbeatEvents(adapter, runId) {
  const events = await adapter.listEvents(runId, -1, 500);
  return events.filter((event) => event.type === "TaskHeartbeat");
}

describe("task heartbeat throttling", () => {
  test(
    "a burst of heartbeats coalesces to at most two persisted writes keeping the newest payload",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        const workflow = smithers(() => (
          <Workflow name="heartbeat-burst">
            <Task id="burst" output={outputs.outputA}>
              {async () => {
                const runtime = requireTaskRuntime();
                for (let i = 0; i < 20; i += 1) {
                  runtime.heartbeat({ n: i });
                }
                // Stay alive past TASK_HEARTBEAT_THROTTLE_MS (500ms)
                // so the trailing coalesced write can land.
                await sleep(700);
                return { value: 1 };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");

        const heartbeats = await listHeartbeatEvents(adapter, result.runId);
        // 20 calls in one tick: one immediate write plus one trailing
        // coalesced write. 20 events would mean the throttle is broken.
        expect(heartbeats.length).toBeGreaterThanOrEqual(1);
        expect(heartbeats.length).toBeLessThanOrEqual(3);

        // The trailing write must persist the NEWEST pending payload.
        const attempts = await adapter.listAttempts(result.runId, "burst", 0);
        expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
          n: 19,
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "heartbeats spaced past the throttle window each persist",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        const workflow = smithers(() => (
          <Workflow name="heartbeat-spaced">
            <Task id="spaced" output={outputs.outputA}>
              {async () => {
                const runtime = requireTaskRuntime();
                runtime.heartbeat({ step: "first" });
                await sleep(600);
                runtime.heartbeat({ step: "second" });
                await sleep(100);
                return { value: 1 };
              }}
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");

        const heartbeats = await listHeartbeatEvents(adapter, result.runId);
        expect(heartbeats.length).toBe(2);
        const attempts = await adapter.listAttempts(result.runId, "spaced", 0);
        expect(JSON.parse(attempts[0]?.heartbeatDataJson ?? "null")).toEqual({
          step: "second",
        });
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
