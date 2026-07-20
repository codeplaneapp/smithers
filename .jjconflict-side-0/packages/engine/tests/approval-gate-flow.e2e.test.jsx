/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { Approval, ApprovalGate, Workflow, Task, Sequence, runWorkflow, approvalDecisionSchema, } from "smithers-orchestrator";
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
describe("approval onDeny=skip", () => {
    test("denial with onDeny=skip does not fail the workflow and records the denial decision", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            approval: approvalDecisionSchema,
            result: z.object({ v: z.number() }),
        });
        const workflow = smithers(() => (<Workflow name="deny-skip">
        <Sequence>
          <Approval id="gate" output={outputs.approval} request={{ title: "Ship it?" }} onDeny="skip"/>
          <Task id="after" output={outputs.result}>
            {{ v: 2 }}
          </Task>
        </Sequence>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            await Effect.runPromise(denyNode(adapter, first.runId, "gate", 0, "not now", "tester"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            // Skip semantics: the denied gate must not fail the run; downstream work runs.
            expect(resumed.status).toBe("finished");
            const decisionRows = await db.select().from(tables.approval);
            expect(decisionRows).toEqual([
                expect.objectContaining({
                    runId: first.runId,
                    nodeId: "gate",
                    iteration: 0,
                    approved: false,
                    note: "not now",
                    decidedBy: "tester",
                }),
            ]);
            const resultRows = await db.select().from(tables.result);
            expect(resultRows).toEqual([
                expect.objectContaining({ nodeId: "after", iteration: 0, v: 2 }),
            ]);
        }
        finally {
            cleanup();
        }
    });
});
describe("<ApprovalGate> conditional gating", () => {
    test("when=true requires a real human decision before the run can finish", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="gate-when-true">
        <ApprovalGate id="deploy-gate" when output={outputs.gate} request={{ title: "Deploy to prod?" }}/>
      </Workflow>));
        try {
            const first = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(first.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const requested = await adapter.getApproval(first.runId, "deploy-gate", 0);
            expect(requested?.status).toBe("requested");
            await Effect.runPromise(approveNode(adapter, first.runId, "deploy-gate", 0, "go", "release-manager"));
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: first.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
            const rows = await db.select().from(tables.gate);
            expect(rows).toEqual([
                expect.objectContaining({
                    nodeId: "deploy-gate",
                    approved: true,
                    note: "go",
                    decidedBy: "release-manager",
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
    test("when=false auto-approves statically without creating an approval request", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="gate-when-false">
        <ApprovalGate id="deploy-gate" when={false} output={outputs.gate} request={{ title: "Deploy to prod?" }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            // No approval wait: the run finishes in a single pass.
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            expect(await adapter.getApproval(result.runId, "deploy-gate", 0)).toBeUndefined();
            const rows = await db.select().from(tables.gate);
            expect(rows).toEqual([
                expect.objectContaining({
                    nodeId: "deploy-gate",
                    approved: true,
                    note: "auto-approved",
                    decidedBy: null,
                    decidedAt: null,
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
});
describe("approval request persistence", () => {
    test("persists request metadata, scopes, users, autoApprove, and waitAsync in the approval row", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="req-meta">
        <Approval id="ship" output={outputs.gate} async request={{
                title: "Ship it?",
                summary: "Release 1.2.3",
                metadata: { ticket: "OPS-42", environment: "prod" },
            }} allowedScopes={["run:admin"]} allowedUsers={["user:will"]} autoApprove={{ after: 5, audit: true }} meta={{ team: "platform" }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(result.status).toBe("waiting-approval");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(result.runId, "ship", 0);
            expect(approval?.status).toBe("requested");
            const request = JSON.parse(approval?.requestJson ?? "{}");
            expect(request).toEqual({
                mode: "decision",
                waitAsync: true,
                title: "Ship it?",
                summary: "Release 1.2.3",
                metadata: expect.objectContaining({
                    ticket: "OPS-42",
                    environment: "prod",
                    team: "platform",
                    approvalAllowedScopes: ["run:admin"],
                    approvalAllowedUsers: ["user:will"],
                    approvalAutoApprove: { after: 5, audit: true },
                }),
                options: [],
                allowedScopes: ["run:admin"],
                allowedUsers: ["user:will"],
                autoApprove: { after: 5, audit: true },
            });
            // A plain <Approval> is not a human task: no human-request row is created.
            const requestId = buildHumanRequestId(result.runId, "ship", 0);
            expect(await adapter.getHumanRequest(requestId)).toBeUndefined();
        }
        finally {
            cleanup();
        }
    });
});
describe("approval autoApprove bounds", () => {
    test("after=0 with audit=false auto-approves immediately and selects the first option by default", async () => {
        const { smithers, outputs, tables, db, dbPath, cleanup } = createTestSmithers({
            pick: z.object({ selected: z.string(), notes: z.string().nullable() }),
        });
        const workflow = smithers(() => (<Workflow name="auto-select">
        <Approval id="pick" mode="select" output={outputs.pick} request={{ title: "Pick" }} options={[
                { key: "light", label: "Light" },
                { key: "heavy", label: "Heavy" },
            ]} autoApprove={{ after: 0, audit: false }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(result.runId, "pick", 0);
            expect(approval?.status).toBe("approved");
            expect(approval?.autoApproved).toBe(true);
            expect(approval?.decidedBy).toBe("smithers:auto");
            // audit=false suppresses the requestedAtMs audit anchor.
            expect(approval?.requestedAtMs).toBeNull();
            expect(JSON.parse(approval?.decisionJson ?? "{}")).toEqual({
                selected: "light",
                notes: "Automatically selected",
            });
            const rows = await db.select().from(tables.pick);
            expect(rows).toEqual([
                expect.objectContaining({
                    nodeId: "pick",
                    selected: "light",
                    notes: "Automatically selected",
                }),
            ]);
        }
        finally {
            cleanup();
        }
    });
    test("after=0 with audit=true records the requestedAtMs audit anchor and the auto-approve event", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="auto-audit">
        <Approval id="gate" output={outputs.gate} request={{ title: "Audit me" }} autoApprove={{ after: 0, audit: true }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const approval = await adapter.getApproval(result.runId, "gate", 0);
            expect(approval?.autoApproved).toBe(true);
            expect(typeof approval?.requestedAtMs).toBe("number");
            const events = await adapter.listEventsByType(result.runId, "ApprovalAutoApproved");
            expect(events).toHaveLength(1);
        }
        finally {
            cleanup();
        }
    });
    test("a negative after threshold never auto-approves; the run still waits for a human", async () => {
        const { smithers, outputs, dbPath, cleanup } = createTestSmithers({
            gate: approvalDecisionSchema,
        });
        const workflow = smithers(() => (<Workflow name="auto-negative">
        <Approval id="gate" output={outputs.gate} request={{ title: "Negative threshold" }} autoApprove={{ after: -1 }}/>
      </Workflow>));
        try {
            const result = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(result.status).toBe("waiting-approval");
        }
        finally {
            cleanup();
        }
    });
});
