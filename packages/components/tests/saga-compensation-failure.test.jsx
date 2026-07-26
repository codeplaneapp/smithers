/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Saga, runWorkflow } from "smithers-orchestrator";
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
function createSagaSmithers() {
  return createTestSmithers({
    reservation: z.object({ resource: z.string() }),
    payment: z.object({ charged: z.boolean() }),
    compensation: z.object({ step: z.string() }),
  });
}
describe("Saga compensation failure", () => {
  workflowTest("a failing compensation fails the run loudly instead of stalling", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    const workflow = smithers(() => (
      <Workflow name="saga-compensation-failure">
        <Saga
          id="checkout"
          onFailure="compensate"
          steps={[
            {
              id: "reserve",
              action: (
                <Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>
              ),
              compensation: (
                <Task id="release-resource" output={outputs.compensation} noRetry>
                  {() => {
                    throw new Error("release failed");
                  }}
                </Task>
              ),
            },
            {
              id: "charge",
              action: (
                <Task id="charge-card" output={outputs.payment} noRetry>
                  {() => {
                    throw new Error("payment failed");
                  }}
                </Task>
              ),
              compensation: (
                <Task id="refund-card" output={outputs.compensation}>
                  {{ step: "charge" }}
                </Task>
              ),
            },
          ]}
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    // The failed compensation surfaces as an unhandled task failure — the
    // run must fail loudly (not stall waiting on a saga that can never
    // settle) and name the compensation task that broke the rollback.
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.error)).toContain("Task failed: release-resource");
    const reservationRows = db.select().from(tables.reservation).all();
    expect(reservationRows.length).toBe(1);
    cleanup();
  });
});
