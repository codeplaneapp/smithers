/** @jsxImportSource react */
/**
 * Approvals as a topbar notification: a bell with a count badge whose tone
 * escalates with the longest-waiting approval, opening a popover that holds
 * the full approve/deny inbox. Approve/deny stays one click from anywhere;
 * the runs rail keeps its whole column for runs.
 */
import { useEffect, useRef, useState } from "react";
import { useGatewayActions, useGatewayApprovals } from "smithers-orchestrator/gateway-react";
import { Button, RowButton } from "smithers-orchestrator/ui";
import { shortRunId, waitTone } from "./monitorModel.ts";
import { Chip } from "./monitorShell.tsx";
import { LiveElapsed, useNowMs } from "./monitorShared.tsx";

export type ApprovalLike = {
  runId: string;
  nodeId: string;
  iteration?: number;
  workflowKey?: string;
  requestTitle?: string;
  requestSummary?: string;
  requestedAtMs?: number;
};

/** Badge urgency = the max wait-escalation across pending approvals. */
export function approvalsUrgency(
  approvals: readonly ApprovalLike[],
  nowMs: number,
): "none" | "waiting" | "crit" {
  if (approvals.length === 0) return "none";
  const crit = approvals.some(
    (approval) =>
      approval.requestedAtMs !== undefined && waitTone(nowMs - approval.requestedAtMs) === "failed",
  );
  return crit ? "crit" : "waiting";
}

export function ApprovalWait({ requestedAtMs }: { requestedAtMs: number | undefined }) {
  const now = useNowMs();
  if (!requestedAtMs) return <span className="mon-dim">—</span>;
  const tone = waitTone(now - requestedAtMs);
  return (
    <span className={`mon-wait tone-${tone}`}>
      waiting <LiveElapsed startMs={requestedAtMs} />
    </span>
  );
}

/** A long request summary earns a More toggle; short ones never clamp. */
const SUMMARY_CLAMP_CHARS = 160;

function ApprovalCard({
  approval,
  busy,
  onOpenRun,
  onDecide,
}: {
  approval: ApprovalLike;
  busy: boolean;
  onOpenRun: (runId: string) => void;
  onDecide: (approval: ApprovalLike, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = approval.requestSummary;
  return (
    <div className="mon-approval">
      <RowButton className="mon-approval-main" onClick={() => onOpenRun(approval.runId)}>
        <div className="mon-approval-title">{approval.requestTitle ?? approval.nodeId}</div>
        <div className="mon-approval-meta">
          <span className="mon-chip">{approval.workflowKey ?? "workflow"}</span>
          <span className="mon-mono mon-dim">{shortRunId(approval.runId)}</span>
          <ApprovalWait requestedAtMs={approval.requestedAtMs} />
        </div>
      </RowButton>
      {summary ? (
        <>
          <div className={`mon-approval-summary${expanded ? " is-open" : ""}`}>{summary}</div>
          {summary.length > SUMMARY_CLAMP_CHARS ? (
            <Button
              variant="link"
              size="sm"
              className="mon-approval-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Less" : "More"}
            </Button>
          ) : null}
        </>
      ) : null}
      <div className="mon-approval-actions">
        <Button variant="outline" className="mon-btn-ok" disabled={busy} onClick={() => onDecide(approval, true)}>
          Approve
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => onDecide(approval, false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ApprovalsList({
  approvals,
  onOpenRun,
  onResult,
  onRefetch,
}: {
  approvals: ApprovalLike[];
  onOpenRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
  onRefetch: () => Promise<unknown>;
}) {
  const actions = useGatewayActions();
  const [decidingKey, setDecidingKey] = useState<string | null>(null);

  const decide = async (approval: ApprovalLike, approved: boolean) => {
    if (!approved && !window.confirm(`Deny "${approval.requestTitle ?? approval.nodeId}"? This fails the waiting gate.`)) {
      return;
    }
    const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
    setDecidingKey(key);
    try {
      await actions.submitApproval({
        runId: approval.runId,
        nodeId: approval.nodeId,
        iteration: approval.iteration ?? 0,
        approved,
        decision: { approved },
      });
      onResult("ok", `${approved ? "Approved" : "Denied"} ${approval.nodeId} on ${shortRunId(approval.runId)}.`);
    } catch (error) {
      onResult("err", `Approval failed: ${error instanceof Error ? error.message : String(error)}`);
      await onRefetch();
    } finally {
      setDecidingKey(null);
    }
  };

  return (
    <div data-testid="monitor-approvals">
      {approvals.map((approval) => {
        const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
        return (
          <ApprovalCard
            key={key}
            approval={approval}
            busy={decidingKey === key}
            onOpenRun={onOpenRun}
            onDecide={(target, approved) => void decide(target, approved)}
          />
        );
      })}
    </div>
  );
}

function BellGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function NotificationsBell({
  onSelectRun,
  onResult,
}: {
  onSelectRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const approvalsQuery = useGatewayApprovals();
  const approvals = (approvalsQuery.data ?? []) as ApprovalLike[];
  const now = useNowMs();
  const urgency = approvalsUrgency(approvals, now);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) queueMicrotask(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <Button
        ref={buttonRef}
        variant="outline"
        size="sm"
        className="mon-notif-btn"
        data-testid="monitor-notif-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={approvals.length ? `Approvals inbox, ${approvals.length} waiting` : "Approvals inbox, none waiting"}
        title={approvals.length ? `${approvals.length} approval${approvals.length === 1 ? "" : "s"} waiting` : "Approvals inbox"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <BellGlyph />
        {urgency !== "none" ? (
          <span
            className={`mon-badge mon-notif-count tone-${urgency === "crit" ? "failed" : "waiting"}`}
            data-testid="monitor-notif-count"
          >
            {approvals.length}
          </span>
        ) : null}
        {urgency === "crit" ? <span className="mon-dot tone-failed mon-dot-pulse" aria-hidden /> : null}
      </Button>
      {open ? (
        <div
          ref={popoverRef}
          className="mon-notif-pop"
          role="dialog"
          aria-label="Approvals inbox"
          tabIndex={-1}
          data-testid="monitor-notif-pop"
        >
          <header className="mon-notif-head">
            <h2 className="mon-kicker">
              Approvals {approvals.length ? <span className="mon-count">{approvals.length}</span> : null}
            </h2>
            <Chip onClick={() => close()}>Close</Chip>
          </header>
          {approvals.length === 0 ? (
            <div className="mon-notif-empty" data-testid="monitor-approvals-empty">
              <span className="mon-dim">No approvals waiting</span>
              <span className="mon-dim">Runs pause here when a gate needs you.</span>
            </div>
          ) : (
            <ApprovalsList
              approvals={approvals}
              onOpenRun={(runId) => {
                onSelectRun(runId);
                close(false);
              }}
              onResult={onResult}
              onRefetch={() => approvalsQuery.refetch()}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
