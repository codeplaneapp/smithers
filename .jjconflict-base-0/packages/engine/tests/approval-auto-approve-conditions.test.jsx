/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import {
    Approval,
    Workflow,
    runWorkflow,
    approvalDecisionSchema,
} from "smithers-orchestrator";
import { approveNode } from "../src/approvals.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { Effect } from "effect";

const TIMEOUT_MS = 30_000;

const schemas = { approval: approvalDecisionSchema };

/**
 * @param {any} workflow
 * @param {string} dbPath
 * @param {any} opts
 */
function runInTestRoot(workflow, dbPath, opts) {
    return Effect.runPromise(
        runWorkflow(workflow, { ...opts, rootDir: dirname(dbPath) }),
    );
}

describe("Approval autoApprove: condition and revertOn interactions", () => {
    test("condition=false blocks auto-approve even after the manual-approval threshold", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (
            <Workflow name="auto-approve-cond-false">
                <Approval
                    id="gate"
                    output={outputs.approval}
                    request={{ title: "Gate" }}
                    autoApprove={{ after: 2, condition: () => false, audit: true }}
                />
            </Workflow>
        ));
        const adapter = new SmithersDb(db);

        // Two manual approvals to build up history.
        for (let i = 0; i < 2; i += 1) {
            const run = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(run.status).toBe("waiting-approval");
            await Effect.runPromise(
                approveNode(adapter, run.runId, "gate", 0, "ok", `human-${i + 1}`),
            );
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: run.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
        }

        // Third run: history has 2 prior manual approvals, but condition=false
        // so auto-approve must NOT fire. The run should still wait for human.
        const next = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(next.status).toBe("waiting-approval");
        cleanup();
    }, TIMEOUT_MS);

    test("condition=true allows auto-approve once threshold is reached", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (
            <Workflow name="auto-approve-cond-true">
                <Approval
                    id="gate"
                    output={outputs.approval}
                    request={{ title: "Gate" }}
                    autoApprove={{ after: 2, condition: () => true, audit: true }}
                />
            </Workflow>
        ));
        const adapter = new SmithersDb(db);

        for (let i = 0; i < 2; i += 1) {
            const run = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(run.status).toBe("waiting-approval");
            await Effect.runPromise(
                approveNode(adapter, run.runId, "gate", 0, "ok", `human-${i + 1}`),
            );
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: run.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
        }

        const auto = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(auto.status).toBe("finished");
        const approval = await adapter.getApproval(auto.runId, "gate", 0);
        expect(approval?.autoApproved).toBe(true);
        cleanup();
    }, TIMEOUT_MS);

    test("revertOn=true blocks auto-approve even when threshold and condition are met", async () => {
        const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
        const workflow = smithers(() => (
            <Workflow name="auto-approve-revert">
                <Approval
                    id="gate"
                    output={outputs.approval}
                    request={{ title: "Gate" }}
                    autoApprove={{
                        after: 2,
                        condition: () => true,
                        revertOn: () => true,
                        audit: true,
                    }}
                />
            </Workflow>
        ));
        const adapter = new SmithersDb(db);

        for (let i = 0; i < 2; i += 1) {
            const run = await runInTestRoot(workflow, dbPath, { input: {} });
            expect(run.status).toBe("waiting-approval");
            await Effect.runPromise(
                approveNode(adapter, run.runId, "gate", 0, "ok", `human-${i + 1}`),
            );
            const resumed = await runInTestRoot(workflow, dbPath, {
                input: {},
                runId: run.runId,
                resume: true,
            });
            expect(resumed.status).toBe("finished");
        }

        // Even though after=2 and condition=true, revertOn=true forces a manual
        // approval — auto-approve must be skipped.
        const reverted = await runInTestRoot(workflow, dbPath, { input: {} });
        expect(reverted.status).toBe("waiting-approval");
        cleanup();
    }, TIMEOUT_MS);
});
