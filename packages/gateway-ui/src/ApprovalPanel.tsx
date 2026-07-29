/** @jsxImportSource react */
import { useEffect, useInsertionEffect, useRef, useState, type CSSProperties } from "react";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import { Skeleton } from "@smithers-orchestrator/ui";
import { ensureGatewayUiStyles, theme } from "./theme";

export type ApprovalPanelProps = {
  /** Filter passed to `useGatewayApprovals({ filter })`. */
  filter?: { workflow?: string; runId?: string; limit?: number };
  /** Poll interval (ms) to refresh the pending list. 0 disables. Default 2000. */
  pollMs?: number;
  /** Called if the submitApproval RPC or pending-list refresh throws. */
  onError?: (error: Error) => void;
  className?: string;
  style?: CSSProperties;
};

type ApprovalRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  workflowKey?: string;
  requestTitle?: string;
  requestSummary?: string;
};

type ApprovalFocusTarget = { key: string; decision: "approve" | "deny" } | { key: null; decision: "status" };

// decide() and the render loop must derive the SAME key or the busy state never matches.
function approvalKey(row: ApprovalRow): string {
  return `${row.runId}:${row.nodeId}:${row.iteration}`;
}

/**
 * The pending approval-gate queue with Approve / confirmed Deny actions. Reads
 * {@link useGatewayApprovals} and submits decisions through
 * {@link useGatewayActions}. Drop it in to make a workflow's human gates
 * actionable from your UI.
 */
export function ApprovalPanel({ filter, pollMs = 2000, onError, className, style }: ApprovalPanelProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const { data, loading, error, refetch } = useGatewayApprovals(filter ? { filter } : undefined);
  const actions = useGatewayActions();
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const [confirmingDeny, setConfirmingDeny] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<{
    key: string;
    approved: boolean;
    target: string;
    runId: string;
    message: string;
  } | null>(null);
  const [decisionFeedback, setDecisionFeedback] = useState<{
    approved: boolean;
    target: string;
    runId: string;
  } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<ApprovalFocusTarget | null>(null);
  const [, setRefreshResultVersion] = useState(0);
  const inFlight = useRef(new Set<string>());
  const actionRefs = useRef(new Map<string, Partial<Record<"approve" | "deny", HTMLButtonElement>>>());
  const statusRef = useRef<HTMLDivElement>(null);
  const reportedCollectionError = useRef<Error | null>(null);
  const pendingApprovals = (data ?? []) as ApprovalRow[];
  // Once the gateway accepts a decision, immediately remove that request from
  // the actionable queue. A failed refresh must not expose a stale retry that
  // would submit the same decision twice.
  const approvals = pendingApprovals.filter((row) => !resolved.has(approvalKey(row)));

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.key === null) {
      statusRef.current?.focus();
      setFocusTarget(null);
      return;
    }
    if (busy.has(focusTarget.key)) return;
    const action = actionRefs.current.get(focusTarget.key)?.[focusTarget.decision];
    if (action) action.focus();
    else statusRef.current?.focus();
    setFocusTarget(null);
  }, [focusTarget, busy]);

  const setActionRef = (key: string, decision: "approve" | "deny", node: HTMLButtonElement | null) => {
    if (node) {
      const refs = actionRefs.current.get(key) ?? {};
      refs[decision] = node;
      actionRefs.current.set(key, refs);
      return;
    }
    const refs = actionRefs.current.get(key);
    if (!refs) return;
    delete refs[decision];
    if (!refs.approve && !refs.deny) actionRefs.current.delete(key);
  };

  const cancelDeny = (key: string) => {
    setConfirmingDeny(null);
    setFocusTarget({ key, decision: "deny" });
  };

  const notifyError = (cause: unknown): Error => {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    try {
      onError?.(err);
    } catch {
      /* observer fault */
    }
    return err;
  };

  useEffect(() => {
    if (!error) {
      if (reportedCollectionError.current) setRefreshError(null);
      reportedCollectionError.current = null;
      return;
    }
    if (reportedCollectionError.current === error) return;
    reportedCollectionError.current = error;
    notifyError(error);
    setRefreshError(
      decisionFeedback
        ? `${decisionFeedback.approved ? "Approved" : "Denied"} gate ${decisionFeedback.target} for run ${decisionFeedback.runId}, but pending approvals could not be refreshed: ${error.message}`
        : `Approval refresh failed: ${error.message}`,
    );
  }, [error, decisionFeedback, onError]);

  // listApprovals is pull-only on the local gateway path, so poll to stay live.
  useEffect(() => {
    if (pollMs <= 0 || typeof refetch !== "function") return;
    const handle = setInterval(() => {
      void refetch()
        .catch((cause) => {
          const err = notifyError(cause);
          setRefreshError(`Approval refresh failed: ${err.message}`);
        })
        .finally(() => setRefreshResultVersion((current) => current + 1));
    }, pollMs);
    return () => clearInterval(handle);
  }, [refetch, pollMs, onError]);

  const decide = async (row: ApprovalRow, approved: boolean) => {
    const key = approvalKey(row);
    const target = row.requestTitle ?? row.nodeId;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setSubmitError(null);
    setRefreshError(null);
    setConfirmingDeny((current) => (current === key ? null : current));
    setBusy((current) => new Set(current).add(key));
    const note = notes[key]?.trim();
    try {
      await actions.submitApproval({
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration,
        decision: { approved, ...(note ? { note } : {}) },
        ...(note ? { note } : {}),
      });
      setResolved((current) => new Set(current).add(key));
      setDecisionFeedback({ approved, target, runId: row.runId });
      const rowIndex = approvals.findIndex((candidate) => approvalKey(candidate) === key);
      const remaining = approvals.filter((candidate) => approvalKey(candidate) !== key);
      const next = remaining[Math.min(Math.max(rowIndex, 0), Math.max(remaining.length - 1, 0))];
      setFocusTarget(next ? { key: approvalKey(next), decision: "approve" } : { key: null, decision: "status" });
      void refetch()
        .catch((cause) => {
          const err = notifyError(cause);
          setRefreshError(
            `${approved ? "Approved" : "Denied"} gate ${target} for run ${row.runId}, but pending approvals could not be refreshed: ${err.message}`,
          );
        })
        .finally(() => setRefreshResultVersion((current) => current + 1));
    } catch (cause) {
      const err = notifyError(cause);
      setSubmitError({ key, approved, target, runId: row.runId, message: err.message });
      setFocusTarget({ key, decision: approved ? "approve" : "deny" });
    } finally {
      inFlight.current.delete(key);
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: theme.fontSans,
        color: theme.text,
        ...style,
      }}
    >
      {decisionFeedback ? (
        <div
          ref={statusRef}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          style={{ color: theme.success, fontSize: 13 }}
        >
          {decisionFeedback.approved ? "Approved" : "Denied"} gate {decisionFeedback.target} for run{" "}
          {decisionFeedback.runId}. {approvals.length}{" "}
          {approvals.length === 1 ? "approval remains" : "approvals remain"} pending.
        </div>
      ) : null}
      {refreshError ? (
        <div role="alert" style={{ color: theme.danger, fontSize: 13 }}>
          {refreshError}
        </div>
      ) : null}
      {error && !refreshError ? (
        <div role="alert" style={{ color: theme.danger, fontSize: 13 }}>
          {decisionFeedback
            ? `${decisionFeedback.approved ? "Approved" : "Denied"} gate ${decisionFeedback.target} for run ${decisionFeedback.runId}, but pending approvals could not be refreshed: ${error.message}`
            : `Approval refresh failed: ${error.message}`}
        </div>
      ) : null}
      {loading && approvals.length === 0 && !error ? (
        <div role="status" aria-label="Loading approvals" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[0, 1].map((index) => (
            <Skeleton key={index} style={{ height: 96, borderRadius: theme.radius }} />
          ))}
        </div>
      ) : null}
      {!loading && approvals.length === 0 && !error ? (
        <div style={{ color: theme.textDim, fontSize: 13 }}>No approvals waiting.</div>
      ) : null}
      {approvals.map((row) => {
        const key = approvalKey(row);
        const isBusy = busy.has(key);
        const denyConfirmationId = `gw-deny-${key}`;
        const meta = `${row.workflowKey ?? ""} · ${row.runId} · ${row.nodeId}#${row.iteration}`;
        return (
          <div
            key={key}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: theme.radius,
              border: `1px solid ${theme.border}`,
              background: theme.panel,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>{row.requestTitle ?? `Approval: ${row.nodeId}`}</div>
            {row.requestSummary ? <div style={{ fontSize: 13, color: theme.textDim }}>{row.requestSummary}</div> : null}
            <div
              title={meta}
              style={{
                fontFamily: theme.fontMono,
                fontSize: 11,
                color: theme.textDim,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {meta}
            </div>
            <label htmlFor={`gw-note-${key}`} style={{ display: "grid", gap: 4, fontSize: 12, color: theme.textDim }}>
              Decision note (optional)
              <textarea
                id={`gw-note-${key}`}
                value={notes[key] ?? ""}
                disabled={isBusy}
                rows={2}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setNotes((current) => ({ ...current, [key]: value }));
                }}
                style={{
                  resize: "vertical",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${theme.border}`,
                  background: theme.bg,
                  color: theme.text,
                  font: "inherit",
                }}
              />
            </label>
            {confirmingDeny === key ? (
              <div
                role="alertdialog"
                aria-labelledby={denyConfirmationId}
                data-approval-deny-confirmation={key}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  cancelDeny(key);
                }}
                style={{
                  display: "grid",
                  gap: 8,
                  padding: 10,
                  borderRadius: 6,
                  border: `1px solid ${theme.dangerBorder}`,
                  background: theme.dangerSoft,
                }}
              >
                <div id={denyConfirmationId} style={{ fontSize: 13, fontWeight: 600 }}>
                  Deny gate {row.requestTitle ?? row.nodeId} for run {row.runId}?
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    autoFocus
                    disabled={isBusy}
                    onClick={() => void decide(row, false)}
                    className="gw-approval-button gw-approval-button-danger"
                  >
                    Confirm deny
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => cancelDeny(key)}
                    className="gw-approval-button gw-approval-button-neutral"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  ref={(node) => setActionRef(key, "approve", node)}
                  type="button"
                  disabled={isBusy}
                  aria-label={`Approve gate ${row.requestTitle ?? row.nodeId} for run ${row.runId}`}
                  onClick={() => void decide(row, true)}
                  className="gw-approval-button gw-approval-button-success"
                >
                  {isBusy ? "Submitting…" : "Approve"}
                </button>
                <button
                  ref={(node) => setActionRef(key, "deny", node)}
                  type="button"
                  disabled={isBusy}
                  aria-label={`Deny gate ${row.requestTitle ?? row.nodeId} for run ${row.runId}`}
                  onClick={() => setConfirmingDeny(key)}
                  className="gw-approval-button gw-approval-button-danger"
                >
                  Deny
                </button>
              </div>
            )}
            {submitError?.key === key ? (
              <div role="alert" style={{ color: theme.danger, fontSize: 13 }}>
                {submitError.approved ? "Approve" : "Deny"} failed for gate {submitError.target} on run{" "}
                {submitError.runId}: {submitError.message}. Try again.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
