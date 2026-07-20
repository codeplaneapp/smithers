import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { __approvalInternals as I, denyNode } from "../src/approvals.js";

describe("approval internals", () => {
    test("normalizes status, decisions and async approval requests", async () => {
        expect(I.nextRunStatusForApproval("running", 0)).toBeNull();
        expect(I.nextRunStatusForApproval("waiting-approval", 1)).toBe("waiting-approval");
        expect(I.nextRunStatusForApproval("waiting-approval", 0)).toBe("waiting-event");
        expect(I.nextRunStatusForApproval("waiting-event", 0)).toBe("waiting-event");

        expect(I.serializeDecision(undefined)).toBeNull();
        expect(I.serializeDecision({ approved: true })).toBe(JSON.stringify({ approved: true }));

        expect(I.isAsyncApprovalRequest(null)).toBe(false);
        expect(I.isAsyncApprovalRequest("{")).toBe(false);
        expect(I.isAsyncApprovalRequest(JSON.stringify({ waitAsync: true }))).toBe(true);
        expect(I.isAsyncApprovalRequest(JSON.stringify({ waitAsync: false }))).toBe(false);

        await expect(Effect.runPromise(I.validateNodeWaitingForApproval("run", "gate", 0, "waiting_approval"))).resolves.toBeUndefined();
        const exit = await Effect.runPromiseExit(I.validateNodeWaitingForApproval("run", "gate", 0, "completed"));
        expect(Exit.isFailure(exit)).toBe(true);
    });

    test("decrements async approval metrics on denial", async () => {
        const rows = {};
        const adapter = {
            getApproval: () => Effect.succeed({
                status: "requested",
                requestJson: JSON.stringify({ waitAsync: true }),
                requestedAtMs: Date.now() - 10,
                decisionJson: JSON.stringify({ from: "existing" }),
            }),
            getNode: () => Effect.succeed({
                state: "waiting-approval",
                lastAttempt: 1,
                outputTable: "decision",
                label: "Gate",
            }),
            withTransactionEffect: (_label, effect) => effect,
            insertOrUpdateApproval: (row) => Effect.sync(() => {
                rows.approval = row;
            }),
            insertNode: (row) => Effect.sync(() => {
                rows.node = row;
            }),
            getRun: () => Effect.succeed({ status: "waiting-approval" }),
            listPendingApprovals: () => Effect.succeed([]),
            updateRun: (_runId, patch) => Effect.sync(() => {
                rows.runPatch = patch;
            }),
            insertEventWithNextSeq: (event) => Effect.sync(() => {
                rows.event = event;
            }),
            db: { $client: { filename: ":memory:" } },
        };

        await Effect.runPromise(denyNode(adapter, "run", "gate", 0, "not yet", "reviewer"));
        expect(rows.approval).toEqual(expect.objectContaining({
            status: "denied",
            note: "not yet",
            decidedBy: "reviewer",
            autoApproved: false,
        }));
        expect(rows.node).toEqual(expect.objectContaining({ state: "failed" }));
        expect(rows.runPatch).toEqual({ status: "waiting-event" });
        expect(rows.event).toEqual(expect.objectContaining({ type: "ApprovalDenied" }));
    });
});
