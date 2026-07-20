/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Parallel, WaitForEvent, Workflow, runWorkflow, signalRun, SmithersDb, } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";
const END_TO_END_TIMEOUT_MS = 30_000;
function buildWaitSmithers() {
    return createTestSmithers({
        filled: z.object({ qty: z.number() }),
    });
}
describe("WaitForEvent correlationId matching through the real engine", () => {
    test("a signal resolves only the waiter whose correlationId matches", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
        try {
            const workflow = smithers(() => (<Workflow name="wfe-correlation-routing">
          <Parallel>
            <WaitForEvent id="wait-a" event="order.filled" correlationId="order-a" output={outputs.filled}/>
            <WaitForEvent id="wait-b" event="order.filled" correlationId="order-b" output={outputs.filled}/>
          </Parallel>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            const adapter = new SmithersDb(db);
            // Each waiter gets a distinctly-correlated payload; routing is proven
            // by which nodeId each payload lands on after the single resume.
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 2 }, { correlationId: "order-b" }));
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 5 }, { correlationId: "order-a" }));
            const done = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(done.status).toBe("finished");
            const rows = await db.select().from(tables.filled);
            expect(rows.length).toBe(2);
            const byNode = new Map(rows.map((row) => [row.nodeId, row.qty]));
            expect(byNode.get("wait-a")).toBe(5);
            expect(byNode.get("wait-b")).toBe(2);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    test("a resume with only one of two waiters resolved applies it and re-parks instead of hanging", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
        try {
            const workflow = smithers(() => (<Workflow name="wfe-correlation-partial-resume">
          <Parallel>
            <WaitForEvent id="wait-a" event="order.filled" correlationId="order-a" output={outputs.filled}/>
            <WaitForEvent id="wait-b" event="order.filled" correlationId="order-b" output={outputs.filled}/>
          </Parallel>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 2 }, { correlationId: "order-b" }));
            // Regression: reconcileEventWait used to re-complete the first
            // already-finished waiter on every pass, so a partially-resolved
            // resume spun forever instead of re-parking (and a fully-resolved
            // resume never reached the second waiter).
            const partial = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(partial.status).toBe("waiting-event");
            const partialRows = await db.select().from(tables.filled);
            expect(partialRows).toEqual([
                expect.objectContaining({ nodeId: "wait-b", iteration: 0, qty: 2 }),
            ]);
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 5 }, { correlationId: "order-a" }));
            const done = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(done.status).toBe("finished");
            const rows = await db.select().from(tables.filled);
            const byNode = new Map(rows.map((row) => [row.nodeId, row.qty]));
            expect(byNode.get("wait-a")).toBe(5);
            expect(byNode.get("wait-b")).toBe(2);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    test("a matching event name with a mismatched correlationId leaves the waiter parked", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
        try {
            const workflow = smithers(() => (<Workflow name="wfe-correlation-mismatch">
          <WaitForEvent id="wait" event="order.filled" correlationId="expected" output={outputs.filled}/>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 9 }, { correlationId: "other" }));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("waiting-event");
            const rows = await db.select().from(tables.filled);
            expect(rows.length).toBe(0);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
    test("a correlated waiter ignores an uncorrelated signal but accepts the correlated one", async () => {
        const { smithers, outputs, tables, db, cleanup } = buildWaitSmithers();
        try {
            const workflow = smithers(() => (<Workflow name="wfe-correlation-null-asymmetry">
          <WaitForEvent id="wait" event="order.filled" correlationId="expected" output={outputs.filled}/>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(first.status).toBe("waiting-event");
            const adapter = new SmithersDb(db);
            // A bare signal (no correlationId) must not resolve a correlated waiter:
            // the snapshot stores "expected" and the signal normalizes to null.
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 1 }));
            const still = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(still.status).toBe("waiting-event");
            expect((await db.select().from(tables.filled)).length).toBe(0);
            await Effect.runPromise(signalRun(adapter, first.runId, "order.filled", { qty: 3 }, { correlationId: "expected" }));
            const done = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: first.runId,
                resume: true,
            }));
            expect(done.status).toBe("finished");
            const rows = await db.select().from(tables.filled);
            expect(rows).toEqual([
                expect.objectContaining({ nodeId: "wait", qty: 3 }),
            ]);
        }
        finally {
            cleanup();
        }
    }, END_TO_END_TIMEOUT_MS);
});
