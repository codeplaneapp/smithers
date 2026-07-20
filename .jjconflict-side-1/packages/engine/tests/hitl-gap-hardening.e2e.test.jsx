/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { Approval, ApprovalGate, EscalationChain, HumanTask, Workflow, runWorkflow, approvalDecisionSchema, } from "smithers-orchestrator";
import { approveNode, denyNode } from "../src/approvals.js";
import { buildHumanRequestId } from "../src/human-requests.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";
import { Effect } from "effect";
/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(runWorkflow(workflow, {
        ...opts,
        rootDir: dirname(dbPath),
    }));
}
describe("<HumanTask> validation retry loop", () => {
    test("maxAttempts=3: one bad answer burns the full retry budget, then reopens the request", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            review: z.object({ score: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="human-correction-loop">
        <HumanTask id="review" output={outputs.review} prompt="Score it" maxAttempts={3}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const requestId = buildHumanRequestId(first.runId, "review", 0);
            await adapter.answerHumanRequest(requestId, JSON.stringify({ score: "high" }), Date.now(), "qa:gina");
            await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "qa:gina"));
            const failed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            // The retry loop is bounded by maxAttempts: every attempt re-reads the
            // same stored answer, so one bad answer consumes the whole budget.
            expect(failed.status).toBe("failed");
            const attempts = await Effect.runPromise(adapter.listAttempts(first.runId, "review", 0));
            expect(attempts).toHaveLength(3);
            for (const attempt of attempts) {
                expect(JSON.parse(attempt?.errorJson ?? "{}").code).toBe("HUMAN_TASK_VALIDATION_FAILED");
            }
            // The next resume reopens the request so a human can correct the answer.
            const reopenedRun = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(reopenedRun.status).toBe("waiting-approval");
            const reopened = await adapter.getHumanRequest(requestId);
            expect(reopened?.status).toBe("pending");
            expect(reopened?.responseJson).toBeNull();
        }
        finally {
            cleanup();
        }
    });
});
describe("<HumanTask> timeout expiration", () => {
    test("an expired request cannot resolve the task: the run fails with HUMAN_TASK_NO_INPUT after expiry", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            review: z.object({ score: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="human-expiry">
        <HumanTask id="review" output={outputs.review} prompt="Score it" timeoutMs={5} maxAttempts={1}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const requestId = buildHumanRequestId(first.runId, "review", 0);
            const request = await adapter.getHumanRequest(requestId);
            expect(request?.timeoutAtMs).toBe((request?.requestedAtMs ?? 0) + 5);
            // Real expiry sweep: the durable store flips the stale row to expired.
            await new Promise((resolve) => setTimeout(resolve, 20));
            await adapter.expireStaleHumanRequests();
            const expired = await adapter.getHumanRequest(requestId);
            expect(expired?.status).toBe("expired");
            expect(await adapter.listPendingHumanRequests(first.runId)).toEqual([]);
            // Even an operator approval cannot resurrect an expired request.
            await Effect.runPromise(approveNode(adapter, first.runId, "review", 0, undefined, "ops"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("failed");
            const attempts = await Effect.runPromise(adapter.listAttempts(first.runId, "review", 0));
            expect(attempts).toHaveLength(1);
            expect(JSON.parse(attempts[0]?.errorJson ?? "{}").code).toBe("HUMAN_TASK_NO_INPUT");
        }
        finally {
            cleanup();
        }
    });
});
describe("<ApprovalGate> denial with onDeny=fail", () => {
    test("a denied gate fails the run, emits ApprovalDenied, and records no gate output", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="gate-deny-fail">
        <ApprovalGate id="deploy-gate" when onDeny="fail" output={outputs.gate} request={{ title: "Deploy to prod?" }}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(denyNode(adapter, first.runId, "deploy-gate", 0, "too risky", "release-manager"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("failed");
            const approval = await adapter.getApproval(first.runId, "deploy-gate", 0);
            expect(approval).toEqual(expect.objectContaining({
                status: "denied",
                note: "too risky",
                decidedBy: "release-manager",
                autoApproved: false,
            }));
            const denied = await adapter.listEventsByType(first.runId, "ApprovalDenied");
            expect(denied).toHaveLength(1);
            // onDeny=fail must not run the decision body: no gate row is written.
            expect(await db.select().from(tables.gate)).toEqual([]);
        }
        finally {
            cleanup();
        }
    });
});
describe("<EscalationChain> human fallback denial", () => {
    test("denying the human fallback records the denial decision without failing the incident run", async () => {
        const escalationSchema = z.object({
            escalated: z.boolean().optional(),
            fromLevel: z.number().optional(),
            toLevel: z.number().optional(),
            approved: z.boolean().optional(),
            note: z.string().nullable().optional(),
            decidedBy: z.string().nullable().optional(),
            decidedAt: z.string().nullable().optional(),
        });
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            level0: z.object({ ok: z.boolean() }),
            level1: z.object({ ok: z.boolean() }),
            escalation: escalationSchema,
        });
        const makeAgent = (id, output) => ({ id, generate: async () => ({ output }) });
        const workflow = smithers(() => (<Workflow name="esc-fallback-deny">
        <EscalationChain id="incident" escalationOutput={outputs.escalation} levels={[
                { agent: makeAgent("junior", { ok: false }), output: outputs.level0 },
                { agent: makeAgent("senior", { ok: false }), output: outputs.level1 },
            ]} humanFallback>
          investigate the incident
        </EscalationChain>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(denyNode(adapter, first.runId, "incident-human-fallback", 0, "stand down", "oncall"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            // The fallback approval is a decision (not a gate): a denial is a valid
            // outcome recorded to the escalation output, not a run failure.
            expect(resumed.status).toBe("finished");
            const escalationRows = await db.select().from(tables.escalation);
            expect(escalationRows).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    nodeId: "incident-human-fallback",
                    approved: false,
                    note: "stand down",
                    decidedBy: "oncall",
                }),
            ]));
        }
        finally {
            cleanup();
        }
    });
});
describe("select-mode approval request persistence and decision payload", () => {
    test("persists mode/options in requestJson and resolves the typed selection from the operator decision", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            pick: z.object({ selected: z.string(), notes: z.string().nullable() }),
        });
        const workflow = smithers(() => (<Workflow name="select-request-json">
        <Approval id="pick" mode="select" output={outputs.pick} request={{ title: "Pick a color" }} options={[
                { key: "blue", label: "Blue" },
                { key: "red", label: "Red" },
            ]}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(first.runId, "pick", 0);
            const request = JSON.parse(approval?.requestJson ?? "{}");
            expect(request).toEqual(expect.objectContaining({
                mode: "select",
                waitAsync: false,
                title: "Pick a color",
                options: [
                    { key: "blue", label: "Blue" },
                    { key: "red", label: "Red" },
                ],
                allowedScopes: [],
                allowedUsers: [],
                autoApprove: null,
            }));
            await Effect.runPromise(approveNode(adapter, first.runId, "pick", 0, undefined, "picker", { selected: "red", notes: "prefer red" }));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.pick);
            expect(rows).toEqual([
                expect.objectContaining({ nodeId: "pick", selected: "red", notes: "prefer red" }),
            ]);
        }
        finally {
            cleanup();
        }
    });
});
describe("rank-mode auto-approve default decision", () => {
    test("after=0 auto-approves with the full option order as the default ranking", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            ranking: z.object({ ranked: z.array(z.string()), notes: z.string().nullable() }),
        });
        const workflow = smithers(() => (<Workflow name="rank-auto-approve">
        <Approval id="order" mode="rank" output={outputs.ranking} request={{ title: "Rank the rollouts" }} options={[
                { key: "canary", label: "Canary" },
                { key: "staged", label: "Staged" },
                { key: "big-bang", label: "Big bang" },
            ]} autoApprove={{ after: 0, audit: true }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(result.runId, "order", 0);
            expect(approval?.status).toBe("approved");
            expect(approval?.autoApproved).toBe(true);
            expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual({
                ranked: ["canary", "staged", "big-bang"],
                notes: "Automatically ranked",
            });
            expect(await adapter.listEventsByType(result.runId, "ApprovalAutoApproved")).toHaveLength(1);
            const rows = await db.select().from(tables.ranking);
            expect(rows).toEqual([
                expect.objectContaining({
                    nodeId: "order",
                    ranked: ["canary", "staged", "big-bang"],
                    notes: "Automatically ranked",
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
});
describe("autoApprove condition/revertOn combination", () => {
    test("condition=true with revertOn=false permits an immediate auto-approve", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="auto-condition-revert-false">
        <Approval id="gate" output={outputs.gate} request={{ title: "Safe change" }} autoApprove={{
                after: 0,
                condition: () => true,
                revertOn: () => false,
            }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            // A false revertOn must not block auto-approval (only revertOn=true does).
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(result.runId, "gate", 0);
            expect(approval?.status).toBe("approved");
            expect(approval?.autoApproved).toBe(true);
            expect(approval?.decidedBy).toBe("smithers:auto");
        }
        finally {
            cleanup();
        }
    });
});
