/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import {
    Approval,
    Parallel,
    SmithersDb,
    Timer,
    WaitForEvent,
    Workflow,
    runWorkflow,
    signalRun,
} from "smithers-orchestrator";
import { approveNode } from "../src/approvals.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const TEST_TIMEOUT_MS = 30_000;

function makeHarness() {
    return createTestSmithers({
        decision: z.object({
            approved: z.boolean(),
            note: z.string().nullable(),
            decidedBy: z.string().nullable(),
            decidedAt: z.string().nullable(),
        }),
        event: z.object({ ok: z.boolean() }),
    });
}

async function persistedWaits(adapter, runId) {
    const nodes = await adapter.listNodes(runId);
    const attempts = [];
    for (const node of nodes) {
        attempts.push(...await Effect.runPromise(adapter.listAttempts(
            runId,
            node.nodeId,
            node.iteration ?? 0,
        )));
    }
    return {
        nodes: nodes.map((node) => ({ nodeId: node.nodeId, state: node.state })),
        attempts: attempts.map((attempt) => ({ nodeId: attempt.nodeId, state: attempt.state })),
    };
}

describe("timer-primary deferred durability", () => {
    test("persists a coexisting approval while Timer owns the run-level wait", async () => {
        const { smithers, outputs, db, cleanup } = makeHarness();
        try {
            const workflow = smithers(() => (<Workflow name="timer-primary-approval">
              <Parallel>
                <Approval id="gate" output={outputs.decision} request={{ title: "Approve now" }}/>
                <Timer id="deadline" duration="1h"/>
              </Parallel>
            </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            const adapter = new SmithersDb(db);
            const waits = await persistedWaits(adapter, result.runId);
            const approvals = await adapter.listPendingApprovals(result.runId);
            expect(result.status).toBe("waiting-timer");
            expect(waits.nodes).toEqual(expect.arrayContaining([
                { nodeId: "gate", state: "waiting-approval" },
                { nodeId: "deadline", state: "waiting-timer" },
            ]));
            expect(waits.attempts).toContainEqual({ nodeId: "deadline", state: "waiting-timer" });
            expect(approvals.map((approval) => approval.nodeId)).toContain("gate");

            await Effect.runPromise(approveNode(adapter, result.runId, "gate", 0));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: result.runId,
                resume: true,
            }));
            const afterApproval = await persistedWaits(adapter, result.runId);
            expect(resumed.status).toBe("waiting-timer");
            expect(afterApproval.nodes).toEqual(expect.arrayContaining([
                { nodeId: "gate", state: "finished" },
                { nodeId: "deadline", state: "waiting-timer" },
            ]));
            expect((await Effect.runPromise(adapter.getApproval(result.runId, "gate", 0)))?.status).toBe("approved");
        }
        finally {
            cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("persists a coexisting event waiter while Timer owns the run-level wait", async () => {
        const { smithers, outputs, tables, db, cleanup } = makeHarness();
        try {
            const workflow = smithers(() => (<Workflow name="timer-primary-event">
              <Parallel>
                <WaitForEvent
                  id="event"
                  event="deploy.ready"
                  correlationId="release-1"
                  output={outputs.event}
                />
                <Timer id="deadline" duration="1h"/>
              </Parallel>
            </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            const adapter = new SmithersDb(db);
            const waits = await persistedWaits(adapter, result.runId);
            const targets = await Effect.runPromise(adapter.findRunsAwaitingEvent(
                "deploy.ready",
                "release-1",
            ));
            expect(result.status).toBe("waiting-timer");
            expect(waits.nodes).toEqual(expect.arrayContaining([
                { nodeId: "event", state: "waiting-event" },
                { nodeId: "deadline", state: "waiting-timer" },
            ]));
            expect(waits.attempts).toEqual(expect.arrayContaining([
                { nodeId: "event", state: "waiting-event" },
                { nodeId: "deadline", state: "waiting-timer" },
            ]));
            expect(targets).toContain(result.runId);

            await Effect.runPromise(signalRun(adapter, result.runId, "deploy.ready", { ok: true }, {
                correlationId: "release-1",
                receivedBy: "test",
            }));
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: result.runId,
                resume: true,
            }));
            const afterSignal = await persistedWaits(adapter, result.runId);
            expect(resumed.status).toBe("waiting-timer");
            expect(afterSignal.nodes).toEqual(expect.arrayContaining([
                { nodeId: "event", state: "finished" },
                { nodeId: "deadline", state: "waiting-timer" },
            ]));
            expect(await db.select().from(tables.event)).toHaveLength(1);
            expect(await Effect.runPromise(adapter.findRunsAwaitingEvent(
                "deploy.ready",
                "release-1",
            ))).not.toContain(result.runId);
        }
        finally {
            cleanup();
        }
    }, TEST_TIMEOUT_MS);
});
