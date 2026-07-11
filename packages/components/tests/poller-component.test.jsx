/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Poller, runWorkflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers, sleep } from "./helpers.js";
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
/**
 * Resume a run that parked on its inter-attempt <Timer> until it settles.
 * The gateway timer sweep plays this role in production.
 * @param {any} workflow
 * @param {any} first
 * @returns {Promise<any>}
 */
async function resumeUntilSettled(workflow, first) {
    let result = first;
    for (let attempt = 0; attempt < 40 && result.status === "waiting-timer"; attempt++) {
        await sleep(25);
        result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: result.runId, resume: true }));
    }
    return result;
}
describe("Poller", () => {
    workflowTest("happy path polls until the condition is satisfied", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            check: z.object({
                satisfied: z.boolean(),
                status: z.string(),
                observedAtAttempt: z.number(),
            }),
            summary: z.object({
                attempts: z.number(),
                satisfied: z.boolean(),
                status: z.string(),
            }),
        });
        let calls = 0;
        const workflow = smithers((ctx) => {
            const checks = ctx.outputs("check");
            const latest = ctx.latest("check", "deploy-check");
            return (<Workflow name="poller-happy">
          <Sequence>
            <Poller id="deploy" check={() => {
                    calls += 1;
                    return {
                        satisfied: calls >= 3,
                        status: calls >= 3 ? "ready" : "pending",
                        observedAtAttempt: calls,
                    };
                }} checkOutput={outputs.check} maxAttempts={5} intervalMs={1} onTimeout="return-last"/>

            <Task id="summary" output={outputs.summary}>
              {{
                    attempts: checks.length,
                    satisfied: latest?.satisfied ?? false,
                    status: latest?.status ?? "unknown",
                }}
            </Task>
          </Sequence>
        </Workflow>);
        });
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        const result = await resumeUntilSettled(workflow, first);
        expect(result.status).toBe("finished");
        expect(calls).toBe(3);
        const checkRows = db
            .select()
            .from(tables.check)
            .all()
            .sort((a, b) => a.iteration - b.iteration);
        const summaryRows = db.select().from(tables.summary).all();
        expect(checkRows.map((row) => row.satisfied)).toEqual([false, false, true]);
        expect(summaryRows.length).toBe(1);
        expect(summaryRows[0].attempts).toBe(3);
        expect(summaryRows[0].satisfied).toBe(true);
        expect(summaryRows[0].status).toBe("ready");
        cleanup();
    });
    workflowTest("condition met early exits after the first check", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            check: z.object({
                satisfied: z.boolean(),
                status: z.string(),
                observedAtAttempt: z.number(),
            }),
            summary: z.object({
                attempts: z.number(),
                satisfied: z.boolean(),
                status: z.string(),
            }),
        });
        let calls = 0;
        const workflow = smithers((ctx) => {
            const checks = ctx.outputs("check");
            const latest = ctx.latest("check", "deploy-check");
            return (<Workflow name="poller-early">
          <Sequence>
            <Poller id="deploy" check={() => {
                    calls += 1;
                    return {
                        satisfied: true,
                        status: "ready",
                        observedAtAttempt: calls,
                    };
                }} checkOutput={outputs.check} maxAttempts={5} intervalMs={1} onTimeout="return-last"/>

            <Task id="summary" output={outputs.summary}>
              {{
                    attempts: checks.length,
                    satisfied: latest?.satisfied ?? false,
                    status: latest?.status ?? "unknown",
                }}
            </Task>
          </Sequence>
        </Workflow>);
        });
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("finished");
        expect(calls).toBe(1);
        const checkRows = db.select().from(tables.check).all();
        const summaryRows = db.select().from(tables.summary).all();
        expect(checkRows.length).toBe(1);
        expect(checkRows[0].satisfied).toBe(true);
        expect(summaryRows[0].attempts).toBe(1);
        cleanup();
    });
    workflowTest("transient check failure retries and still completes", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            check: z.object({
                satisfied: z.boolean(),
                status: z.string(),
                observedAtAttempt: z.number(),
            }),
            summary: z.object({
                attempts: z.number(),
                satisfied: z.boolean(),
                status: z.string(),
            }),
        });
        let calls = 0;
        const workflow = smithers((ctx) => {
            const checks = ctx.outputs("check");
            const latest = ctx.latest("check", "deploy-check");
            return (<Workflow name="poller-retry">
          <Sequence>
            <Poller id="deploy" check={() => {
                    calls += 1;
                    if (calls === 1) {
                        throw new Error("transient network error");
                    }
                    return {
                        satisfied: calls >= 3,
                        status: calls >= 3 ? "ready" : "pending",
                        observedAtAttempt: calls,
                    };
                }} checkOutput={outputs.check} maxAttempts={5} intervalMs={1} onTimeout="return-last"/>

            <Task id="summary" output={outputs.summary}>
              {{
                    attempts: checks.length,
                    satisfied: latest?.satisfied ?? false,
                    status: latest?.status ?? "unknown",
                }}
            </Task>
          </Sequence>
        </Workflow>);
        });
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        const result = await resumeUntilSettled(workflow, first);
        expect(result.status).toBe("finished");
        expect(calls).toBe(3);
        const checkRows = db
            .select()
            .from(tables.check)
            .all()
            .sort((a, b) => a.iteration - b.iteration);
        const summaryRows = db.select().from(tables.summary).all();
        expect(checkRows.length).toBe(2);
        expect(checkRows.map((row) => row.satisfied)).toEqual([false, true]);
        expect(summaryRows[0].attempts).toBe(2);
        expect(summaryRows[0].satisfied).toBe(true);
        cleanup();
    });
    workflowTest("poll attempts are separated by a real intervalMs delay", async () => {
        const { Workflow, smithers, outputs, db, cleanup } = createTestSmithers({
            check: z.object({ satisfied: z.boolean() }),
        });
        /** @type {number[]} */
        const stamps = [];
        const workflow = smithers(() => (<Workflow name="poller-real-delay">
        <Poller id="deploy" check={() => {
                stamps.push(Date.now());
                return { satisfied: stamps.length >= 3 };
            }} checkOutput={outputs.check} maxAttempts={5} intervalMs={120} backoff="fixed" onTimeout="return-last"/>
      </Workflow>));
        // The run parks on the durable delay rather than spinning in-process:
        // that parking IS the fix for the "burns all attempts instantly" bug.
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(first.status).toBe("waiting-timer");
        const result = await resumeUntilSettled(workflow, first);
        expect(result.status).toBe("finished");
        expect(stamps).toHaveLength(3);
        // Before the fix all three checks landed within a few ms of each other.
        expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(100);
        expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(100);
        expect(stamps[2] - stamps[0]).toBeGreaterThanOrEqual(200);
        cleanup();
    });
    workflowTest("the inter-attempt delay is a durable engine timer, one per gap", async () => {
        const { Workflow, smithers, outputs, db, cleanup } = createTestSmithers({
            check: z.object({ satisfied: z.boolean() }),
        });
        let calls = 0;
        const workflow = smithers(() => (<Workflow name="poller-durable-delay">
        <Poller id="deploy" check={() => {
                calls += 1;
                return { satisfied: calls >= 3 };
            }} checkOutput={outputs.check} maxAttempts={5} intervalMs={60} backoff="fixed" onTimeout="return-last"/>
      </Workflow>));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        const result = await resumeUntilSettled(workflow, first);
        expect(result.status).toBe("finished");
        expect(calls).toBe(3);
        const adapter = new SmithersDb(db);
        const events = await adapter.listEvents(first.runId, -1, 1_000);
        const types = events.map((event) => event.type);
        // 3 attempts -> exactly 2 gaps -> 2 durable timers fired. This is what
        // distinguishes an engine timer from an in-process setTimeout.
        expect(types.filter((type) => type === "TimerFired")).toHaveLength(2);
        expect(types.filter((type) => type === "TimerCreated").length).toBeGreaterThanOrEqual(2);
        expect(types).toContain("NodeWaitingTimer");
        cleanup();
    });
    workflowTest("onTimeout fail exhausts attempts and fails the run", async () => {
        const { Workflow, Task, Sequence, smithers, outputs, tables, db, cleanup, } = createTestSmithers({
            check: z.object({
                satisfied: z.boolean(),
                status: z.string(),
                observedAtAttempt: z.number(),
            }),
            summary: z.object({
                attempts: z.number(),
            }),
        });
        let calls = 0;
        const workflow = smithers((ctx) => {
            const checks = ctx.outputs("check");
            return (<Workflow name="poller-timeout-fail">
          <Sequence>
            <Poller id="deploy" check={() => {
                    calls += 1;
                    return {
                        satisfied: false,
                        status: "pending",
                        observedAtAttempt: calls,
                    };
                }} checkOutput={outputs.check} maxAttempts={2} intervalMs={1} onTimeout="fail"/>

            <Task id="summary" output={outputs.summary}>
              {{ attempts: checks.length }}
            </Task>
          </Sequence>
        </Workflow>);
        });
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        const result = await resumeUntilSettled(workflow, first);
        expect(result.status).toBe("failed");
        expect(calls).toBe(2);
        const checkRows = db
            .select()
            .from(tables.check)
            .all()
            .sort((a, b) => a.iteration - b.iteration);
        const summaryRows = db.select().from(tables.summary).all();
        expect(checkRows.map((row) => row.satisfied)).toEqual([false, false]);
        expect(summaryRows).toHaveLength(0);
        cleanup();
    });
});
