/** @jsxImportSource react */
import { useEffect, useInsertionEffect, useRef, useState, type CSSProperties } from "react";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import { ensureGatewayUiStyles, theme } from "./theme";

export type ApprovalPanelProps = {
  /** Filter passed to `useGatewayApprovals({ filter })`. */
  filter?: { workflow?: string; runId?: string; limit?: number };
  /** Poll interval (ms) to refresh the pending list. 0 disables. Default 2000. */
  pollMs?: number;
  /** Called if the submitApproval RPC throws. */
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
  const [confirmingDeny, setConfirmingDeny] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<{ key: string; message: string } | null>(null);
  const inFlight = useRef(new Set<string>());
  const approvals = (data ?? []) as ApprovalRow[];

  // listApprovals is pull-only on the local gateway path, so poll to stay live.
  useEffect(() => {
    if (pollMs <= 0 || typeof refetch !== "function") return;
    const handle = setInterval(refetch, pollMs);
    return () => clearInterval(handle);
  }, [refetch, pollMs]);

  const decide = async (row: ApprovalRow, approved: boolean) => {
    const key = approvalKey(row);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setSubmitError(null);
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
      refetch?.();
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      setSubmitError({ key, message: err.message });
      onError?.(err);
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
      {error ? <div style={{ color: theme.danger, fontSize: 13 }}>{error.message}</div> : null}
      {!loading && approvals.length === 0 && !error ? (
        <div style={{ color: theme.textDim, fontSize: 13 }}>No approvals waiting.</div>
      ) : null}
      {approvals.map((row) => {
        const key = approvalKey(row);
        const isBusy = busy.has(key);
        const denyConfirmationId = `gw-deny-${key}`;
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
            <div style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.textDim }}>
              {String(row.workflowKey ?? "")} · {row.runId} · {row.nodeId}#{row.iteration}
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
                    onClick={() => setConfirmingDeny(null)}
                    className="gw-approval-button gw-approval-button-neutral"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  disabled={isBusy}
                  aria-label={`Approve gate ${row.requestTitle ?? row.nodeId} for run ${row.runId}`}
                  onClick={() => void decide(row, true)}
                  className="gw-approval-button gw-approval-button-success"
                >
                  {isBusy ? "Submitting…" : "Approve"}
                </button>
                <button
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
              <div style={{ color: theme.danger, fontSize: 13 }}>{submitError.message}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
