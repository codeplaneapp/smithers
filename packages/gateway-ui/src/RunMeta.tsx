/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { useGatewayRun } from "@smithers-orchestrator/gateway-react";
import { StatusPill } from "@smithers-orchestrator/ui";
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
  const run = typeof record.run === "object" && record.run !== null
    ? (record.run as Record<string, unknown>)
    : record;
  return typeof run.status === "string" ? run.status : undefined;
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
      {runId ? (
        <code style={{ fontFamily: theme.fontMono, fontSize: 11 }}>{runId}</code>
      ) : (
        <span>no run</span>
      )}
      <StatusPill status={status ?? (runId ? "pending" : "unknown")} />
      {showConnection ? <ConnectionBadge /> : null}
    </span>
  );
}
