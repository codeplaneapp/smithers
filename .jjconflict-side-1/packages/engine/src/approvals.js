import { Effect, Metric } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { approvalWaitDuration, trackEvent, updateAsyncExternalWaitPending, } from "@smithers-orchestrator/observability/metrics";
import { bridgeApprovalResolve } from "./effect/durable-deferred-bridge.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string | null | undefined} currentStatus
 * @param {number} pendingApprovals
 * @returns {"waiting-approval" | "waiting-event" | null}
 */
function nextRunStatusForApproval(currentStatus, pendingApprovals) {
    if (currentStatus !== "waiting-approval" &&
        currentStatus !== "waiting-event") {
        return null;
    }
    return pendingApprovals > 0 ? "waiting-approval" : "waiting-event";
}
/**
 * @param {unknown} decision
 */
function serializeDecision(decision) {
    return decision === undefined ? null : JSON.stringify(decision);
}
/**
 * @param {string | null | undefined} requestJson
 * @returns {{ runId: string; nodeId: string; iteration: number; fingerprint: string; authorizedAttempt: number } | null}
 */
function parseReplayUnsafeApprovalRequest(requestJson) {
    if (!requestJson)
        return null;
    try {
        const request = JSON.parse(requestJson);
        if (request?.kind !== "ReplayUnsafeApproval" ||
            typeof request.runId !== "string" ||
            typeof request.nodeId !== "string" ||
            !Number.isSafeInteger(request.iteration) ||
            typeof request.fingerprint !== "string" ||
            !Number.isSafeInteger(request.authorizedAttempt)) {
            return null;
        }
        return {
            runId: request.runId,
            nodeId: request.nodeId,
            iteration: request.iteration,
            fingerprint: request.fingerprint,
            authorizedAttempt: request.authorizedAttempt,
        };
    }
    catch {
        return null;
    }
}
/**
 * @param {string | null | undefined} requestJson
 * @param {unknown} decision
 * @param {boolean} approved
 * @returns {string | null}
 */
function serializeApprovalDecision(requestJson, decision, approved) {
    const replayRequest = parseReplayUnsafeApprovalRequest(requestJson);
    if (!replayRequest) {
        return serializeDecision(decision);
    }
    return JSON.stringify({
        kind: "ReplayUnsafeApproval",
        approved,
        fingerprint: replayRequest.fingerprint,
        authorizedAttempt: replayRequest.authorizedAttempt,
        ...(decision === undefined ? {} : { decision }),
    });
}
/**
 * @param {string | null} [requestJson]
 */
function isAsyncApprovalRequest(requestJson) {
    if (!requestJson)
        return false;
    try {
        return JSON.parse(requestJson)?.waitAsync === true;
    }
    catch {
        return false;
    }
}
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string | null | undefined} state
 * @returns {Effect.Effect<void, SmithersError>}
 */
function validateNodeWaitingForApproval(runId, nodeId, iteration, state) {
    if (state === "waiting-approval" || state === "waiting_approval") {
        return Effect.void;
    }
    return Effect.fail(new SmithersError("INVALID_INPUT", `Node ${nodeId} is not waiting for approval.`, { runId, nodeId, iteration, state: state ?? null }));
}
/**
 * Shared core of approveNode/denyNode: persist the decision, move the node,
 * emit the event, and signal the in-process deferred.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string | undefined} note
 * @param {string | undefined} decidedBy
 * @param {unknown} decision
 * @param {{ approved: boolean, autoApproved: boolean }} resolution
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
function resolveApprovalNode(adapter, runId, nodeId, iteration, note, decidedBy, decision, { approved, autoApproved }) {
    const ts = nowMs();
    return Effect.gen(function* () {
        let approvalNodeId = nodeId;
        let approvalIteration = iteration;
        let existing = yield* adapter.getApproval(runId, approvalNodeId, approvalIteration);
        if (existing?.status !== "requested") {
            const pendingApprovals = yield* adapter.listPendingApprovals(runId);
            const pendingReplayApproval = pendingApprovals.find((approval) => {
                const request = parseReplayUnsafeApprovalRequest(approval.requestJson);
                return request?.runId === runId
                    && request.nodeId === nodeId
                    && request.iteration === iteration;
            });
            if (pendingReplayApproval) {
                approvalNodeId = pendingReplayApproval.nodeId;
                approvalIteration = pendingReplayApproval.iteration;
                existing = pendingReplayApproval;
            }
        }
        const replayRequest = parseReplayUnsafeApprovalRequest(existing?.requestJson);
        const targetNodeId = replayRequest?.nodeId ?? nodeId;
        const targetIteration = replayRequest?.iteration ?? iteration;
        const currentNode = yield* adapter.getNode(runId, targetNodeId, targetIteration);
        yield* validateNodeWaitingForApproval(runId, targetNodeId, targetIteration, currentNode?.state);
        const decisionJson = serializeApprovalDecision(existing?.requestJson, decision, approved)
            ?? existing?.decisionJson
            ?? null;
        const event = {
            type: approved
                ? (autoApproved ? "ApprovalAutoApproved" : "ApprovalGranted")
                : "ApprovalDenied",
            runId,
            nodeId: approvalNodeId,
            iteration: approvalIteration,
            timestampMs: ts,
        };
        yield* adapter.withTransactionEffect("approval", Effect.gen(function* () {
            yield* adapter.insertOrUpdateApproval({
                runId,
                nodeId: approvalNodeId,
                iteration: approvalIteration,
                status: approved ? "approved" : "denied",
                requestedAtMs: null,
                decidedAtMs: ts,
                note: note ?? null,
                decidedBy: decidedBy ?? null,
                requestJson: existing?.requestJson ?? null,
                decisionJson,
                autoApproved,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: targetNodeId,
                iteration: targetIteration,
                // Approval re-arms the node to run; denial fails it.
                state: approved ? "pending" : "failed",
                lastAttempt: currentNode?.lastAttempt ?? null,
                updatedAtMs: nowMs(),
                outputTable: currentNode?.outputTable ?? "",
                label: currentNode?.label ?? null,
            });
            const run = yield* adapter.getRun(runId);
            if (run) {
                const pending = yield* adapter.listPendingApprovals(runId);
                const nextStatus = nextRunStatusForApproval(run.status, pending.length);
                if (nextStatus && run.status !== nextStatus) {
                    yield* adapter.updateRun(runId, { status: nextStatus });
                }
            }
        }));
        if (existing?.requestedAtMs) {
            yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
        }
        if (existing?.status === "requested" && isAsyncApprovalRequest(existing.requestJson)) {
            yield* updateAsyncExternalWaitPending("approval", -1);
        }
        yield* adapter.insertEventWithNextSeq({
            runId,
            timestampMs: ts,
            type: event.type,
            payloadJson: JSON.stringify(event),
        });
        yield* trackEvent(event);
        yield* Effect.logInfo(approved
            ? (autoApproved ? "approval auto-approved" : "approval granted")
            : "approval denied");
        yield* Effect.promise(() =>
            bridgeApprovalResolve(adapter, runId, targetNodeId, targetIteration, {
                approved,
                // Pass the note through as-is (string | undefined); bridgeApprovalResolve
                // omits the `note` key when it is absent so optional string schemas validate.
                note,
                decidedBy: decidedBy ?? null,
                decisionJson,
                // The deny payload carries no `autoApproved` key at all (not even false).
                ...(approved ? { autoApproved } : {}),
            }).catch((bridgeError) => {
                // The decision is already durably committed in the DB. A bridge
                // failure here is non-fatal: the in-process deferred will not be
                // signalled, but the run will recover on its next heartbeat/resume
                // because the persisted approval row drives re-hydration. Failing
                // the Effect here would strand the caller with an INTERNAL_ERROR
                // while the decision is already consumed — worse than the bridge
                // being a no-op.
                const message = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
                console.warn(`[approvals] post-commit bridgeApprovalResolve failed (non-fatal, run will re-drive on resume): ${message}`);
            })
        );
    }).pipe(Effect.annotateLogs({
        runId,
        nodeId,
        iteration,
        approvalStatus: approved
            ? (autoApproved ? "auto-approved" : "approved")
            : "denied",
        approvalDecidedBy: decidedBy ?? null,
    }), Effect.withLogSpan(approved ? "approval:grant" : "approval:deny"));
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @param {boolean} [autoApproved]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
export function approveNode(adapter, runId, nodeId, iteration, note, decidedBy, decision, autoApproved = false) {
    return resolveApprovalNode(adapter, runId, nodeId, iteration, note, decidedBy, decision, { approved: true, autoApproved });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
export function denyNode(adapter, runId, nodeId, iteration, note, decidedBy, decision) {
    return resolveApprovalNode(adapter, runId, nodeId, iteration, note, decidedBy, decision, { approved: false, autoApproved: false });
}
export const __approvalInternals = {
    isAsyncApprovalRequest,
    nextRunStatusForApproval,
    serializeDecision,
    validateNodeWaitingForApproval,
};
