/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
import type { ListApprovalsRequest } from "@smithers-orchestrator/gateway-client/rpc";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  type ApprovalState,
} from "../../ui/src/approvals/Confirmation";
import { ApprovalNote } from "../../ui/src/approvals/ApprovalCard";

/** The canonical synthetic id for a pending approval row. */
export function gatewayApprovalKey(row: GatewayApprovalRow): string {
  return `${row.runId}:${row.nodeId}:${row.iteration}`;
}

export type GatewayApprovalConfirmationProps = {
  /** The approval row to render and resolve (host/list selects it). */
  approval: GatewayApprovalRow;
  /** Render an ApprovalNote and thread the note into the decision payload. */
  note?: boolean;
  onResolved?: (key: string, approved: boolean) => void;
  className?: string;
};

/**
 * A Gateway-connected Confirmation for one pending approval row. Submits
 * exactly `submitApproval({ runId, nodeId, iteration, approved, decision:
 * { approved, note? }, note? })`; requested → approving|denying in flight →
 * approved|denied on resolve, failed-submission (retryable) on reject, and
 * expired when the row leaves the approvals collection while unresolved.
 */
export function GatewayApprovalConfirmation({
  approval,
  note = false,
  onResolved,
  className,
}: GatewayApprovalConfirmationProps) {
  const actions = useGatewayActions();
  const { data, loading } = useGatewayApprovals({ filter: { runId: approval.runId } });
  const [state, setState] = useState<ApprovalState>("requested");
  const [noteValue, setNoteValue] = useState("");
  const inFlight = useRef(false);
  const key = gatewayApprovalKey(approval);

  // The row leaving the collection before we resolved it means someone else
  // (or a timeout) closed the gate: expire instead of hanging on "requested".
  useEffect(() => {
    if (loading || inFlight.current) return;
    if (state !== "requested" && state !== "failed-submission") return;
    const rows = data ?? [];
    if (!rows.some((row) => gatewayApprovalKey(row) === key)) setState("expired");
  }, [data, loading, state, key]);

  async function decide(approved: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setState(approved ? "approving" : "denying");
    const trimmed = noteValue.trim();
    try {
      await actions.submitApproval({
        runId: approval.runId,
        nodeId: approval.nodeId,
        iteration: approval.iteration,
        approved,
        decision: { approved, ...(note && trimmed !== "" ? { note: trimmed } : {}) },
        ...(note && trimmed !== "" ? { note: trimmed } : {}),
      });
      setState(approved ? "approved" : "denied");
      onResolved?.(key, approved);
    } catch {
      setState("failed-submission");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Confirmation state={state} className={className}>
      <ConfirmationTitle>{approval.requestTitle ?? `Approval: ${approval.nodeId}`}</ConfirmationTitle>
      <ConfirmationRequest>
        {approval.requestSummary ? <div>{approval.requestSummary}</div> : null}
        <div>
          {approval.workflowKey ? `${approval.workflowKey} · ` : ""}
          {approval.runId} · {approval.nodeId}#{approval.iteration}
        </div>
        {note ? <ApprovalNote value={noteValue} onValueChange={setNoteValue} /> : null}
      </ConfirmationRequest>
      <ConfirmationActions>
        <ConfirmationAction decision="approve" onDecide={(decision) => void decide(decision === "approve")} />
        <ConfirmationAction decision="deny" onDecide={(decision) => void decide(decision === "approve")} />
      </ConfirmationActions>
      <ConfirmationAccepted />
      <ConfirmationRejected />
    </Confirmation>
  );
}

export type GatewayApprovalListProps = {
  /** Filter passed to `useGatewayApprovals({ filter })`. */
  filter?: NonNullable<ListApprovalsRequest["filter"]>;
  /** Render an ApprovalNote per row and thread it into each decision. */
  note?: boolean;
  /** Slot rendered when no approvals are pending. */
  empty?: ReactNode;
  onResolved?: (key: string, approved: boolean) => void;
  className?: string;
};

/**
 * The pending-approval queue: maps `useGatewayApprovals({ filter })` rows
 * (keyed by {@link gatewayApprovalKey}) to GatewayApprovalConfirmation cards.
 * Renders a synchronizing Confirmation while the collection first loads and
 * the `empty` slot when no gates are waiting.
 */
export function GatewayApprovalList({ filter, note, empty, onResolved, className }: GatewayApprovalListProps) {
  const { data, loading, error } = useGatewayApprovals(filter ? { filter } : {});
  const rows = data ?? [];

  if (error) {
    return (
      <div className={className}>
        <Confirmation state="unavailable">
          <ConfirmationTitle>Approvals unavailable</ConfirmationTitle>
        </Confirmation>
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div className={className}>
        <Confirmation state="synchronizing">
          <ConfirmationTitle>Synchronizing approvals…</ConfirmationTitle>
          <ConfirmationRequest />
        </Confirmation>
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className={className}>{empty ?? null}</div>;
  }

  return (
    <div className={className}>
      {rows.map((row) => (
        <GatewayApprovalConfirmation key={gatewayApprovalKey(row)} approval={row} note={note} onResolved={onResolved} />
      ))}
    </div>
  );
}
