import { Effect, Metric } from "effect";
import { nowMs } from "../utils/time";
import { SmithersDb } from "../db/adapter";
import { runPromise } from "../effect/runtime";
import { approvalWaitDuration, trackEvent } from "../effect/metrics";

function nextRunStatusForApproval(
  currentStatus: string | null | undefined,
  pendingApprovals: number,
): "waiting-approval" | "waiting-event" | null {
  if (
    currentStatus !== "waiting-approval" &&
    currentStatus !== "waiting-event"
  ) {
    return null;
  }
  return pendingApprovals > 0 ? "waiting-approval" : "waiting-event";
}

export function approveNodeEffect(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  const ts = nowMs();
  const event = {
    type: "ApprovalGranted" as const,
    runId,
    nodeId,
    iteration,
    timestampMs: ts,
  };
  return Effect.gen(function* () {
    const existing = yield* adapter.getApprovalEffect(runId, nodeId, iteration);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        const existingNode = yield* adapter.getNodeEffect(runId, nodeId, iteration);
        yield* adapter.insertOrUpdateApprovalEffect({
          runId,
          nodeId,
          iteration,
          status: "approved",
          requestedAtMs: null,
          decidedAtMs: ts,
          note: note ?? null,
          decidedBy: decidedBy ?? null,
        });
        yield* adapter.insertNodeEffect({
          runId,
          nodeId,
          iteration,
          state: "pending",
          lastAttempt: existingNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });

        const run = yield* adapter.getRunEffect(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovalsEffect(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRunEffect(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: "ApprovalGranted",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo("approval granted");
  }).pipe(
    Effect.annotateLogs({
      runId,
      nodeId,
      iteration,
      approvalStatus: "approved",
      approvalDecidedBy: decidedBy ?? null,
    }),
    Effect.withLogSpan("approval:grant"),
  );
}

export async function approveNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  await runPromise(
    approveNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy),
  );
}

export function denyNodeEffect(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  const ts = nowMs();
  const event = {
    type: "ApprovalDenied" as const,
    runId,
    nodeId,
    iteration,
    timestampMs: ts,
  };
  return Effect.gen(function* () {
    const existing = yield* adapter.getApprovalEffect(runId, nodeId, iteration);
    yield* adapter.withTransactionEffect(
      "approval",
      Effect.gen(function* () {
        const existingNode = yield* adapter.getNodeEffect(runId, nodeId, iteration);
        yield* adapter.insertOrUpdateApprovalEffect({
          runId,
          nodeId,
          iteration,
          status: "denied",
          requestedAtMs: null,
          decidedAtMs: ts,
          note: note ?? null,
          decidedBy: decidedBy ?? null,
        });
        yield* adapter.insertNodeEffect({
          runId,
          nodeId,
          iteration,
          state: "failed",
          lastAttempt: existingNode?.lastAttempt ?? null,
          updatedAtMs: nowMs(),
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });

        const run = yield* adapter.getRunEffect(runId);
        if (run) {
          const pending = yield* adapter.listPendingApprovalsEffect(runId);
          const nextStatus = nextRunStatusForApproval(run.status, pending.length);
          if (nextStatus && run.status !== nextStatus) {
            yield* adapter.updateRunEffect(runId, { status: nextStatus });
          }
        }
      }),
    );
    if (existing?.requestedAtMs) {
      yield* Metric.update(approvalWaitDuration, ts - existing.requestedAtMs);
    }
    yield* adapter.insertEventWithNextSeqEffect({
      runId,
      timestampMs: ts,
      type: "ApprovalDenied",
      payloadJson: JSON.stringify(event),
    });
    yield* trackEvent(event);
    yield* Effect.logInfo("approval denied");
  }).pipe(
    Effect.annotateLogs({
      runId,
      nodeId,
      iteration,
      approvalStatus: "denied",
      approvalDecidedBy: decidedBy ?? null,
    }),
    Effect.withLogSpan("approval:deny"),
  );
}

export async function denyNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  await runPromise(
    denyNodeEffect(adapter, runId, nodeId, iteration, note, decidedBy),
  );
}
