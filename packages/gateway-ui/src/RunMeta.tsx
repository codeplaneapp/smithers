/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayRun } from "@smthrs/gateway-react";
import { StatusPill } from "@smthrs/ui";
import { ConnectionBadge } from "./ConnectionBadge";
import { theme } from "./theme";

export type RunMetaProps = {
  /** The run to describe. */
  runId: string | undefined;
  /** Include the live gateway {@link ConnectionBadge} (default true). */
  showConnection?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * Test seam: the run hook to read from. Defaults to {@link useGatewayRun}.
   * @internal
   */
  useRun?: typeof useGatewayRun;
};

function runStatusOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const run = typeof record.run === "object" && record.run !== null ? (record.run as Record<string, unknown>) : record;
  return typeof run.status === "string" ? run.status : undefined;
}

function runStartedByOf(data: unknown): { harness?: string; sessionId?: string; detected?: true } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const run = typeof record.run === "object" && record.run !== null ? (record.run as Record<string, unknown>) : record;
  const value = run.startedBy;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const startedBy = value as Record<string, unknown>;
  const harness =
    typeof startedBy.harness === "string" && startedBy.harness.trim() ? startedBy.harness.trim() : undefined;
  const sessionId =
    typeof startedBy.sessionId === "string" && startedBy.sessionId.trim() ? startedBy.sessionId.trim() : undefined;
  if (!harness && !sessionId) return undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(startedBy.detected === true ? { detected: true } : {}),
  };
}

/**
 * The standard header meta cluster for a workflow UI: `run-id · status ·
 * connection`, live off {@link useGatewayRun}. Drop it into
 * `WorkflowUiShell`'s `meta` slot instead of hand-formatting run ids and
 * status text.
 *
 * @example
 * <WorkflowUiShell title="View Convergence Fleet" meta={<RunMeta runId={runId} />}>
 */
export function RunMeta({ runId, showConnection = true, className, style, useRun = useGatewayRun }: RunMetaProps) {
  const run = useRun(runId);
  const status = runStatusOf(run.data);
  const startedBy = runStartedByOf(run.data);
  return (
    <span
      className={className}
      data-slot="run-meta"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: theme.fontSans,
        fontSize: 12,
        color: theme.textDim,
        ...style,
      }}
    >
      {runId ? <code style={{ fontFamily: theme.fontMono, fontSize: 11 }}>{runId}</code> : <span>no run</span>}
      <StatusPill status={status ?? (runId ? "pending" : "unknown")} />
      {startedBy ? (
        <span
          data-slot="run-started-by"
          aria-label={`Started by ${startedBy.harness ?? "unknown"}${startedBy.sessionId ? ` ${startedBy.sessionId}` : ""}${startedBy.detected ? ", auto-detected" : ""}`}
          title={`Started by ${startedBy.harness ?? "unknown"}${startedBy.sessionId ? ` · ${startedBy.sessionId}` : ""}${startedBy.detected ? " · auto-detected" : ""}`}
          style={{ border: `1px solid ${theme.border}`, borderRadius: 999, padding: "2px 6px", fontSize: 11 }}
        >
          {startedBy.harness ?? "session"}
        </span>
      ) : null}
      {showConnection ? <ConnectionBadge /> : null}
    </span>
  );
}
