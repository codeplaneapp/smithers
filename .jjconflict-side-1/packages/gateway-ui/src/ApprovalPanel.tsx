/** @jsxImportSource react */
import { useEffect, useState, type CSSProperties } from "react";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

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
 * The pending approval-gate queue with one-click Approve / Deny. Reads
 * {@link useGatewayApprovals} and submits decisions through
 * {@link useGatewayActions}. Drop it in to make a workflow's human gates
 * actionable from your UI.
 */
export function ApprovalPanel({ filter, pollMs = 2000, onError, className, style }: ApprovalPanelProps) {
  const { data, loading, error, refetch } = useGatewayApprovals(filter ? { filter } : undefined);
  const actions = useGatewayActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<{ key: string; message: string } | null>(null);
  const approvals = (data ?? []) as ApprovalRow[];

  // listApprovals is pull-only on the local gateway path, so poll to stay live.
  useEffect(() => {
    if (pollMs <= 0 || typeof refetch !== "function") return;
    const handle = setInterval(refetch, pollMs);
    return () => clearInterval(handle);
  }, [refetch, pollMs]);

  const decide = async (row: ApprovalRow, approved: boolean) => {
    setSubmitError(null);
    setBusy(approvalKey(row));
    try {
      await actions.submitApproval({
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration,
        decision: { approved },
      });
      refetch?.();
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      setSubmitError({ key: approvalKey(row), message: err.message });
      onError?.(err);
    } finally {
      setBusy(null);
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
        const isBusy = busy === key;
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
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {row.requestTitle ?? `Approval: ${row.nodeId}`}
            </div>
            {row.requestSummary ? (
              <div style={{ fontSize: 13, color: theme.textDim }}>{row.requestSummary}</div>
            ) : null}
            <div style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.textDim }}>
              {String(row.workflowKey ?? "")} · {row.runId} · {row.nodeId}#{row.iteration}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(row, true)}
                style={approvalButtonStyle(theme.success, theme.successSoft, theme.successBorder, isBusy)}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(row, false)}
                style={approvalButtonStyle(theme.danger, theme.dangerSoft, theme.dangerBorder, isBusy)}
              >
                Deny
              </button>
            </div>
            {submitError?.key === key ? (
              <div style={{ color: theme.danger, fontSize: 13 }}>{submitError.message}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function approvalButtonStyle(
  color: string,
  background: string,
  borderColor: string,
  disabled: boolean,
): CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 6,
    border: `1px solid ${borderColor}`,
    background,
    color,
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
