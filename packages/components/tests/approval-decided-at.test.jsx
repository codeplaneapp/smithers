/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { Approval } from "../src/components/index.js";
import { createTestSmithers } from "./helpers.js";

async function render(el) {
    const renderer = new SmithersRenderer();
    return renderer.render(el);
}

function runtimeFor(db, runId, nodeId, iteration = 0) {
    return { db, runId, nodeId, iteration };
}

describe("Approval regression: decidedAt and autoApprove callback evaluation", () => {
    test("decision output decidedAt reflects decidedAtMs as an ISO string", async () => {
        const decidedAtMs = 1_716_000_000_000;
        const { db, cleanup } = createTestSmithers({});
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        try {
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-decided-at",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs,
                note: "looks good",
                decidedBy: "alice",
                requestJson: null,
                decisionJson: null,
                autoApproved: false,
            });

            const rendered = await render(
                <Approval id="approval-decided-at" output="out" request={{ title: "Approve" }} />,
            );

            const decision = await withTaskRuntime(
                runtimeFor(db, "run", "approval-decided-at"),
                () => rendered.tasks[0].computeFn(),
            );

            // Pre-fix this was hardcoded to null. It must reflect the stored decidedAtMs.
            expect(decision.decidedAt).not.toBeNull();
            expect(decision.decidedAt).toBe(new Date(decidedAtMs).toISOString());
            expect(decision).toEqual({
                approved: true,
                note: "looks good",
                decidedBy: "alice",
                decidedAt: new Date(decidedAtMs).toISOString(),
            });
        }
        finally {
            cleanup();
        }
    });

    test("decision output decidedAt stays null when decidedAtMs is unset", async () => {
        const { db, cleanup } = createTestSmithers({});
        ensureSmithersTables(db);
        const adapter = new SmithersDb(db);
        try {
            await adapter.insertOrUpdateApproval({
                runId: "run",
                nodeId: "approval-no-decided-at",
                iteration: 0,
                status: "approved",
                requestedAtMs: 1,
                decidedAtMs: null,
                note: null,
                decidedBy: null,
                requestJson: null,
                decisionJson: null,
                autoApproved: false,
            });

            const rendered = await render(
                <Approval id="approval-no-decided-at" output="out" request={{ title: "Approve" }} />,
            );

            const decision = await withTaskRuntime(
                runtimeFor(db, "run", "approval-no-decided-at"),
                () => rendered.tasks[0].computeFn(),
            );

            expect(decision.decidedAt).toBeNull();
        }
        finally {
            cleanup();
        }
    });

    test("autoApprove.condition callback is invoked exactly once per render", async () => {
        let conditionCalls = 0;
        let revertOnCalls = 0;

        const rendered = await render(
            <Approval
                id="approval-once"
                output="out"
                request={{ title: "Auto" }}
                autoApprove={{
                    condition: () => {
                        conditionCalls += 1;
                        return true;
                    },
                    revertOn: () => {
                        revertOnCalls += 1;
                        return false;
                    },
                }}
            />,
        );

        // Pre-fix the callbacks were evaluated twice (once in the guard, once in
        // the spread). Each callback must run exactly once per render.
        expect(conditionCalls).toBe(1);
        expect(revertOnCalls).toBe(1);
        expect(rendered.tasks[0].approvalAutoApprove).toEqual({
            audit: true,
            conditionMet: true,
            revertOnMet: false,
        });
    });
});
