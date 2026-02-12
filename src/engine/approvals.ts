import { nowMs } from "../utils/time";
import { SmithersDb } from "../db/adapter";

export async function approveNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  const ts = nowMs();
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId,
    iteration,
    status: "approved",
    requestedAtMs: null,
    decidedAtMs: ts,
    note: note ?? null,
    decidedBy: decidedBy ?? null,
  });
  await adapter.insertEventWithNextSeq({
    runId,
    timestampMs: ts,
    type: "ApprovalGranted",
    payloadJson: JSON.stringify({
      type: "ApprovalGranted",
      runId,
      nodeId,
      iteration,
      timestampMs: ts,
    }),
  });
  await adapter.insertNode({
    runId,
    nodeId,
    iteration,
    state: "pending",
    lastAttempt: null,
    updatedAtMs: nowMs(),
    outputTable: "",
    label: null,
  });
}

export async function denyNode(
  adapter: SmithersDb,
  runId: string,
  nodeId: string,
  iteration: number,
  note?: string,
  decidedBy?: string,
) {
  const ts = nowMs();
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId,
    iteration,
    status: "denied",
    requestedAtMs: null,
    decidedAtMs: ts,
    note: note ?? null,
    decidedBy: decidedBy ?? null,
  });
  await adapter.insertEventWithNextSeq({
    runId,
    timestampMs: ts,
    type: "ApprovalDenied",
    payloadJson: JSON.stringify({
      type: "ApprovalDenied",
      runId,
      nodeId,
      iteration,
      timestampMs: ts,
    }),
  });
  await adapter.insertNode({
    runId,
    nodeId,
    iteration,
    state: "failed",
    lastAttempt: null,
    updatedAtMs: nowMs(),
    outputTable: "",
    label: null,
  });
}
