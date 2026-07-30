/** @jsxImportSource react */
import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import type { GatewayApprovalRow } from "@smithers-orchestrator/gateway-client";
import type { ListApprovalsRequest, SubmitApprovalRequest } from "@smithers-orchestrator/gateway-client/rpc";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import {
  Button,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
  ApprovalNote,
  type ApprovalState,
} from "@smithers-orchestrator/ui";

/** The canonical synthetic id for a pending approval row. */
export function gatewayApprovalKey(row: GatewayApprovalRow): string {
  return `${row.runId}:${row.nodeId}:${row.iteration}`;
}

/** Submit the canonical gateway approval payload for one pending row. */
export function submitDecision(
  submitApproval: (request: SubmitApprovalRequest) => Promise<unknown>,
  approval: GatewayApprovalRow,
  approved: boolean,
  note?: string,
): Promise<unknown> {
  const trimmed = note?.trim();
  return submitApproval({
    runId: approval.runId,
    nodeId: approval.nodeId,
    iteration: approval.iteration,
    approved,
    decision: { approved, ...(trimmed ? { note: trimmed } : {}) },
    ...(trimmed ? { note: trimmed } : {}),
  });
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
 * through {@link submitDecision}; requested → approving|denying in flight →
 * approved|denied on resolve, failed-submission (retryable) on reject,
 * expired when the row leaves the approvals collection while unresolved, and
 * unavailable (recovering to requested) while the approvals read fails. A
 * change of approval identity (runId:nodeId:iteration) without a remount
 * resets the card to requested, and the settle of an in-flight submission
 * for the previous identity never touches the current gate's state.
 */
export function GatewayApprovalConfirmation({
  approval,
  note = false,
  onResolved,
  className,
}: GatewayApprovalConfirmationProps) {
  const actions = useGatewayActions();
  const { data, loading, error } = useGatewayApprovals({ filter: { runId: approval.runId } });
  const [state, setState] = useState<ApprovalState>("requested");
  const [noteValue, setNoteValue] = useState("");
  const [confirmingDeny, setConfirmingDeny] = useState(false);
  const inFlight = useRef(false);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const restoreDenyFocus = useRef(false);
  const key = gatewayApprovalKey(approval);

  useEffect(() => {
    if (confirmingDeny || !restoreDenyFocus.current) return;
    restoreDenyFocus.current = false;
    denyButtonRef.current?.focus();
  }, [confirmingDeny]);

  function cancelDeny() {
    restoreDenyFocus.current = true;
    setConfirmingDeny(false);
  }

  // Identity transition: a host may swap the approval prop without remounting
  // (the list keys rows, a direct caller may not). A stale approved/denied or
  // in-flight state must never bleed onto a different gate — reset to
  // requested and let the collection effect re-derive expiry/availability.
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    inFlight.current = false;
    setState("requested");
    setNoteValue("");
    setConfirmingDeny(false);
  }, [key]);

  // The row leaving the collection before we resolved it means someone else
  // (or a timeout) closed the gate: expire instead of hanging on "requested".
  // A failed collection read is NOT a disappearance — data drains to [] on
  // error, which would falsely expire a still-pending gate, so surface it as
  // unavailable and recover to requested once the read succeeds again.
  useEffect(() => {
    if (loading || inFlight.current) return;
    if (error) {
      if (state === "requested" || state === "failed-submission") setState("unavailable");
      return;
    }
    const rows = data ?? [];
    const present = rows.some((row) => gatewayApprovalKey(row) === key);
    if (state === "unavailable") {
      if (present) setState("requested");
      return;
    }
    if (state !== "requested" && state !== "failed-submission") return;
    if (!present) setState("expired");
  }, [data, loading, error, state, key]);

  async function decide(approved: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirmingDeny(false);
    const submittedKey = key;
    setState(approved ? "approving" : "denying");
    // If the approval identity changes while this submission is in flight,
    // the settle below belongs to the PREVIOUS gate: it must never write
    // state for the current one.
    const isCurrentIdentity = () => keyRef.current === submittedKey;
    try {
      await submitDecision(actions.submitApproval, approval, approved, note ? noteValue : undefined);
      // A consumer observer throwing must not convert a successful
      // submission into a failure state.
      try {
        onResolved?.(submittedKey, approved);
      } catch {
        /* observer fault — the submission already succeeded */
      }
      if (isCurrentIdentity()) setState(approved ? "approved" : "denied");
    } catch {
      if (isCurrentIdentity()) setState("failed-submission");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Confirmation state={state} className={className} data-approval-key={key}>
      <ConfirmationTitle>{approval.requestTitle ?? `Approval: ${approval.nodeId}`}</ConfirmationTitle>
      <ConfirmationRequest>
        {approval.requestSummary ? <div>{approval.requestSummary}</div> : null}
        <div>
          {approval.workflowKey ? `${approval.workflowKey} · ` : ""}
          {approval.runId} · {approval.nodeId}#{approval.iteration}
        </div>
        {note ? (
          <ApprovalNote
            value={noteValue}
            onValueChange={setNoteValue}
            readOnly={state === "approving" || state === "denying"}
          />
        ) : null}
      </ConfirmationRequest>
      {confirmingDeny ? (
        <div
          data-slot="deny-confirmation"
          role="alertdialog"
          aria-label={`Confirm denial of ${approval.requestTitle ?? approval.nodeId} for run ${approval.runId}`}
          className="sui-confirm-deny"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            cancelDeny();
          }}
        >
          <div>
            Deny gate {approval.requestTitle ?? approval.nodeId} for run {approval.runId}?
          </div>
          <ConfirmationActions>
            <ConfirmationAction decision="deny" autoFocus onDecide={() => void decide(false)}>
              Confirm deny
            </ConfirmationAction>
            <Button variant="outline" onClick={cancelDeny}>
              Cancel
            </Button>
          </ConfirmationActions>
        </div>
      ) : (
        <ConfirmationActions>
          <ConfirmationAction decision="approve" onDecide={() => void decide(true)} />
          <ConfirmationAction ref={denyButtonRef} decision="deny" onDecide={() => setConfirmingDeny(true)} />
        </ConfirmationActions>
      )}
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
  const listRef = useRef<HTMLDivElement>(null);
  const focusedApproval = useRef<string | null>(null);
  const previousKeys = useRef<string[]>([]);

  useEffect(() => {
    const keys = rows.map(gatewayApprovalKey);
    const previous = previousKeys.current;
    previousKeys.current = keys;
    const focusedKey = focusedApproval.current;
    if (!focusedKey || keys.includes(focusedKey)) return;

    const previousIndex = previous.indexOf(focusedKey);
    const actions = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-decision='approve']");
    const nextAction = actions?.[Math.min(Math.max(previousIndex, 0), Math.max(actions.length - 1, 0))];
    focusedApproval.current = null;
    if (nextAction) nextAction.focus();
    else listRef.current?.focus();
  }, [rows]);

  const listProps = {
    ref: listRef,
    className,
    tabIndex: -1,
    role: "group" as const,
    "aria-label": "Pending approvals",
    onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
      const card = (event.target as Element).closest<HTMLElement>("[data-approval-key]");
      if (card) focusedApproval.current = card.dataset.approvalKey ?? null;
    },
    onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
        focusedApproval.current = null;
      }
    },
  };

  if (error) {
    return (
      <div {...listProps}>
        <Confirmation state="unavailable">
          <ConfirmationTitle>Approvals unavailable</ConfirmationTitle>
        </Confirmation>
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <div {...listProps}>
        <Confirmation state="synchronizing">
          <ConfirmationTitle>Synchronizing approvals…</ConfirmationTitle>
          <ConfirmationRequest />
        </Confirmation>
      </div>
    );
  }

  if (rows.length === 0) {
    return <div {...listProps}>{empty ?? null}</div>;
  }

  return (
    <div {...listProps}>
      {rows.map((row) => (
        <GatewayApprovalConfirmation key={gatewayApprovalKey(row)} approval={row} note={note} onResolved={onResolved} />
      ))}
    </div>
  );
}
