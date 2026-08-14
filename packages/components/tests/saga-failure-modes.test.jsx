/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Saga, runWorkflow } from "smthrs";
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
    shipment: z.object({ dispatched: z.boolean() }),
    compensation: z.object({ step: z.string() }),
  });
}
describe("Saga onFailure modes", () => {
  workflowTest("onFailure=fail fails the run without running compensations", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    const workflow = smithers(() => (
      <Workflow name="saga-on-failure-fail">
        <Saga
          id="checkout"
          onFailure="fail"
          steps={[
            {
              id: "reserve",
              action: (
                <Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>
              ),
              compensation: (
                <Task id="release-resource" output={outputs.compensation}>
                  {{ step: "reserve" }}
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
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.error)).toContain("Saga checkout failed");
    const reservationRows = db.select().from(tables.reservation).all();
    const compensationRows = db.select().from(tables.compensation).all();
    expect(reservationRows.length).toBe(1);
    expect(compensationRows.length).toBe(0);
    cleanup();
  });
  workflowTest("onFailure=compensate-and-fail compensates completed steps and still fails the run", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    const workflow = smithers(() => (
      <Workflow name="saga-compensate-and-fail">
        <Saga
          id="checkout"
          onFailure="compensate-and-fail"
          steps={[
            {
              id: "reserve",
              action: (
                <Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>
              ),
              compensation: (
                <Task id="release-resource" output={outputs.compensation}>
                  {{ step: "reserve" }}
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
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.error)).toContain("Saga checkout failed");
    const compensationRows = db.select().from(tables.compensation).all();
    expect(compensationRows.length).toBe(1);
    expect(compensationRows[0].step).toBe("reserve");
    cleanup();
  });
  workflowTest("mid-chain failure compensates every completed step in reverse order", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    /** @type {string[]} */
    const compensationOrder = [];
    const workflow = smithers(() => (
      <Workflow name="saga-reverse-order">
        <Saga
          id="fulfillment"
          steps={[
            {
              id: "reserve",
              action: (
                <Task id="reserve-resource" output={outputs.reservation}>
                  {{ resource: "inventory" }}
                </Task>
              ),
              compensation: (
                <Task id="release-resource" output={outputs.compensation}>
                  {() => {
                    compensationOrder.push("reserve");
                    return { step: "reserve" };
                  }}
                </Task>
              ),
            },
            {
              id: "charge",
              action: (
                <Task id="charge-card" output={outputs.payment}>
                  {{ charged: true }}
                </Task>
              ),
              compensation: (
                <Task id="refund-card" output={outputs.compensation}>
                  {() => {
                    compensationOrder.push("charge");
                    return { step: "charge" };
                  }}
                </Task>
              ),
            },
            {
              id: "ship",
              action: (
                <Task id="dispatch-shipment" output={outputs.shipment} noRetry>
                  {() => {
                    throw new Error("carrier unavailable");
                  }}
                </Task>
              ),
              compensation: (
                <Task id="cancel-shipment" output={outputs.compensation}>
                  {{ step: "ship" }}
                </Task>
              ),
            },
          ]}
        />
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(compensationOrder).toEqual(["charge", "reserve"]);
    const compensationRows = db.select().from(tables.compensation).all();
    expect(compensationRows.map((row) => row.step).sort()).toEqual(["charge", "reserve"]);
    const shipmentRows = db.select().from(tables.shipment).all();
    expect(shipmentRows.length).toBe(0);
    cleanup();
  });
});
describe("Saga JSX step children", () => {
  workflowTest("<Saga.Step> children execute actions without compensation on success", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    const workflow = smithers(() => (
      <Workflow name="saga-jsx-happy">
        <Saga id="checkout">
          <Saga.Step
            id="reserve"
            compensation={
              <Task id="release-resource" output={outputs.compensation}>
                {{ step: "reserve" }}
              </Task>
            }
          >
            <Task id="reserve-resource" output={outputs.reservation}>
              {{ resource: "inventory" }}
            </Task>
          </Saga.Step>
          <Saga.Step
            id="charge"
            compensation={
              <Task id="refund-card" output={outputs.compensation}>
                {{ step: "charge" }}
              </Task>
            }
          >
            <Task id="charge-card" output={outputs.payment}>
              {{ charged: true }}
            </Task>
          </Saga.Step>
        </Saga>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(db.select().from(tables.reservation).all().length).toBe(1);
    expect(db.select().from(tables.payment).all().length).toBe(1);
    expect(db.select().from(tables.compensation).all().length).toBe(0);
    cleanup();
  });
  workflowTest("<Saga.Step> children compensate completed steps when a later step fails", async () => {
    const { Workflow, Task, smithers, outputs, tables, db, cleanup } = createSagaSmithers();
    const workflow = smithers(() => (
      <Workflow name="saga-jsx-compensate">
        <Saga id="checkout">
          <Saga.Step
            id="reserve"
            compensation={
              <Task id="release-resource" output={outputs.compensation}>
                {{ step: "reserve" }}
              </Task>
            }
          >
            <Task id="reserve-resource" output={outputs.reservation}>
              {{ resource: "inventory" }}
            </Task>
          </Saga.Step>
          <Saga.Step
            id="charge"
            compensation={
              <Task id="refund-card" output={outputs.compensation}>
                {{ step: "charge" }}
              </Task>
            }
          >
            <Task id="charge-card" output={outputs.payment} noRetry>
              {() => {
                throw new Error("payment failed");
              }}
            </Task>
          </Saga.Step>
        </Saga>
      </Workflow>
    ));
    const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
    expect(result.status).toBe("finished");
    expect(db.select().from(tables.reservation).all().length).toBe(1);
    expect(db.select().from(tables.payment).all().length).toBe(0);
    const compensationRows = db.select().from(tables.compensation).all();
    expect(compensationRows.length).toBe(1);
    expect(compensationRows[0].step).toBe("reserve");
    cleanup();
  });
});
