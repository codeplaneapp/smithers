/** @jsxImportSource react */
import { useEffect, useInsertionEffect, useRef, useState, type CSSProperties } from "react";
import { useGatewayRuns } from "@smthrs/gateway-react";
import type { GatewayRunSummaryRow } from "@smthrs/gateway-client";
import { Alert, AlertDescription, RelativeTime, Skeleton } from "@smthrs/ui";
import { StatusPill } from "./StatusPill";
import { ensureGatewayUiStyles, theme, visuallyHidden } from "./theme";

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

/** Full local date+time for hover titles. */
function fullTime(ms: number): string {
  return new Date(ms).toLocaleString();
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

  // Announce status transitions to assistive technology. The first populated
  // snapshot only seeds the baseline — everything arrives "new" on mount.
  const previousStatuses = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const statusSignature = runs.map((run) => `${run.runId}:${String(run.status ?? "")}`).join("|");
  useEffect(() => {
    const next = new Map(runs.map((run) => [run.runId, String(run.status ?? "")]));
    const previous = previousStatuses.current;
    previousStatuses.current = next;
    if (previous === null) return;
    const changes: string[] = [];
    for (const [runId, status] of next) {
      const before = previous.get(runId);
      if (before !== undefined && before !== status) changes.push(`Run ${runId} is now ${status || "unknown"}`);
    }
    if (changes.length > 0) setAnnouncement(changes.join(". "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSignature]);

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
      <div role="status" aria-live="polite" style={visuallyHidden}>
        {announcement}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message ?? "Failed to load runs."}</AlertDescription>
        </Alert>
      ) : null}
      {loading && runs.length === 0 ? (
        <div role="status" aria-label="Loading runs" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} style={{ height: 56, borderRadius: theme.radius }} />
          ))}
        </div>
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
              {run.createdAtMs ? (
                <RelativeTime
                  ts={run.createdAtMs}
                  title={fullTime(run.createdAtMs)}
                  style={{ fontSize: 11, color: theme.textDim }}
                />
              ) : null}
              <StatusPill status={run.status} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
