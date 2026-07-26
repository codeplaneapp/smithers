/** @jsxImportSource react */
import { useEffect, useInsertionEffect, type CSSProperties } from "react";
import { useGatewayRuns } from "@smithers-orchestrator/gateway-react";
import type { GatewayRunSummaryRow } from "@smithers-orchestrator/gateway-client";
import { StatusPill } from "./StatusPill";
import { ensureGatewayUiStyles, theme } from "./theme";

export type RunListProps = {
  /** Filter passed straight to `useGatewayRuns({ filter })`. */
  filter?: { workflow?: string; limit?: number; status?: string };
  /** The currently selected run, highlighted in the list. */
  activeRunId?: string;
  /** Called with the runId when a row is clicked. */
  onSelect?: (runId: string) => void;
  /** Poll interval (ms) to refetch the list. 0 disables polling. Default 2000. */
  pollMs?: number;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the runs hook to read from. Defaults to {@link useGatewayRuns}.
   * Injectable so the error branch (which the local gateway path never triggers
   * — `useGatewayRuns` currently returns `error: undefined`) can be exercised
   * against the {@link GatewayAsyncState} contract without a live failure.
   * @internal
   */
  useRuns?: typeof useGatewayRuns;
};

export function shortTime(ms: number | undefined): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

/**
 * A live list of runs from the gateway. Reads {@link useGatewayRuns} and renders
 * one selectable row per run with a {@link StatusPill}. Pass `onSelect` to drive
 * a detail pane (e.g. {@link RunEventLog} / {@link RunTree}).
 */
export function RunList({
  filter,
  activeRunId,
  onSelect,
  pollMs = 2000,
  className,
  style,
  useRuns = useGatewayRuns,
}: RunListProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const { data, loading, error, refetch } = useRuns(filter ? { filter } : undefined);
  const runs = (data ?? []) as GatewayRunSummaryRow[];

  // listRuns is pull-only on the local gateway path, so poll to stay live.
  useEffect(() => {
    if (pollMs <= 0 || typeof refetch !== "function") return;
    const handle = setInterval(refetch, pollMs);
    return () => clearInterval(handle);
  }, [refetch, pollMs]);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: theme.fontSans,
        color: theme.text,
        ...style,
      }}
    >
      {error ? (
        <div style={{ color: theme.danger, fontSize: 13, padding: 8 }}>{error.message ?? "Failed to load runs."}</div>
      ) : null}
      {loading && runs.length === 0 ? (
        <div style={{ color: theme.textDim, fontSize: 13, padding: 8 }}>Loading runs…</div>
      ) : null}
      {!loading && runs.length === 0 && !error ? (
        <div style={{ color: theme.textDim, fontSize: 13, padding: 8 }}>No runs yet.</div>
      ) : null}
      {runs.map((run) => {
        const active = run.runId === activeRunId;
        return (
          <button
            key={run.runId}
            type="button"
            onClick={() => onSelect?.(run.runId)}
            className="gw-run-row"
            data-active={active}
          >
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{String(run.workflowKey ?? "workflow")}</span>
              <span
                style={{
                  fontFamily: theme.fontMono,
                  fontSize: 11,
                  color: theme.textDim,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {run.runId}
              </span>
              {run.startedBy?.harness ? (
                <span
                  style={{ fontSize: 11, color: theme.textDim }}
                  title={`Started by ${run.startedBy.harness}${run.startedBy.sessionId ? ` · ${run.startedBy.sessionId}` : ""}${run.startedBy.detected ? " · auto-detected" : ""}`}
                >
                  {run.startedBy.harness}
                </span>
              ) : null}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: theme.textDim }}>{shortTime(run.createdAtMs)}</span>
              <StatusPill status={run.status} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
