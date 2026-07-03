/** @jsxImportSource react */
import { useEffect, useState, type CSSProperties } from "react";
import { useGatewayActions, useGatewayApprovals } from "@smithers-orchestrator/gateway-react";
import { theme } from "./theme";

export type ApprovalPanelProps = {
  /** Filter passed to `useGatewayApprovals({ filter })`. */
  filter?: { workflow?: string; runId?: string; limit?: number };
  /** Poll interval (ms) to refresh the pending list. 0 disables. Default 2000. */
  pollMs?: number;
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

/**
 * The pending approval-gate queue with one-click Approve / Deny. Reads
 * {@link useGatewayApprovals} and submits decisions through
 * {@link useGatewayActions}. Drop it in to make a workflow's human gates
 * actionable from your UI.
 */
export function ApprovalPanel({ filter, pollMs = 2000, className, style }: ApprovalPanelProps) {
  const { data, loading, error, refetch } = useGatewayApprovals(filter ? { filter } : undefined);
  const actions = useGatewayActions();
  const [busy, setBusy] = useState<string | null>(null);
  const approvals = (data ?? []) as ApprovalRow[];

  useEffect(() => {
    if (pollMs <= 0 || typeof refetch !== "function") return;
    const handle = setInterval(refetch, pollMs);
    return () => clearInterval(handle);
  }, [refetch, pollMs]);

  const decide = async (row: ApprovalRow, approved: boolean) => {
    const key = `${row.runId}:${row.nodeId}:${row.iteration}`;
    setBusy(key);
    try {
      await actions.submitApproval({
        runId: row.runId,
        nodeId: row.nodeId,
        iteration: row.iteration,
        decision: { approved },
      });
      refetch?.();
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
        const key = `${row.runId}:${row.nodeId}:${row.iteration}`;
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
                style={btnStyle(theme.success, isBusy)}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => decide(row, false)}
                style={btnStyle(theme.danger, isBusy)}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function btnStyle(bg: string, disabled: boolean): CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 6,
    border: "none",
    background: bg,
    // Inverse text keeps contrast on the solid semantic button in both themes
    // (white on the deep light-mode fills, near-black on the lighter dark-mode
    // fills); falls back to white when the style guide CSS is absent.
    color: "var(--inverse-text, #ffffff)",
    fontWeight: 600,
    fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
