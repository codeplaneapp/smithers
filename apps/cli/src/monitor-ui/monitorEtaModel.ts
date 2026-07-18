/** Honest, client-side ETA and workload calculations for the monitor. */
import {
  asString,
  formatDurationMs,
  isRecord,
  isTerminalStatus,
  toneForStatus,
  type NodeStateRow,
  type TimelineEntry,
} from "./monitorModel.ts";

export function settledPaceSamples(entries: readonly TimelineEntry[]): number[] {
  return entries.flatMap((entry) =>
    toneForStatus(entry.state) === "ok" || toneForStatus(entry.state) === "failed"
      ? entry.startedAtMs !== undefined && entry.durationMs !== undefined ? [entry.durationMs] : []
      : [],
  );
}

export function classifyEntries(entries: readonly TimelineEntry[]) {
  const settled: TimelineEntry[] = [];
  const inFlight: TimelineEntry[] = [];
  const remaining: TimelineEntry[] = [];
  for (const entry of entries) {
    const tone = toneForStatus(entry.state);
    if (tone === "ok" || tone === "failed" || tone === "idle") settled.push(entry);
    else if (entry.startedAtMs !== undefined) inFlight.push(entry);
    // Unlike buildTimeline's ordering-only pending/queued rule, a waiting row
    // without a real attempt start is workload remaining, not work in flight.
    else remaining.push(entry);
  }
  return { settled, inFlight, remaining };
}

export function hasOpenEndedWork(rows: readonly NodeStateRow[], treeNodes?: ReadonlyArray<{ kind?: unknown }>): boolean {
  return rows.some((row) => row.iteration > 0) || (treeNodes?.some((node) => {
    const kind = asString(node.kind)?.toLowerCase();
    return kind === "loop" || kind === "foreach";
  }) ?? false);
}

export function estimateRun(entries: readonly TimelineEntry[], nowMs: number, opts?: { openEnded?: boolean }) {
  const { inFlight, remaining } = classifyEntries(entries);
  const samples = settledPaceSamples(entries);
  const base = { sampleSize: samples.length, remainingTasks: remaining.length, inFlightTasks: inFlight.length };
  if (samples.length === 0) return { kind: "unknown" as const, ...base };
  const avgTaskDurationMs = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  // An active task that has outlived the average is not "0s away". Count every
  // unsettled known task at the measured pace; the result stays approximate
  // without pretending overdue work has already finished.
  const remainingMs = avgTaskDurationMs * (remaining.length + inFlight.length);
  return {
    kind: opts?.openEnded ? "at-least" as const : "estimate" as const,
    remainingMs,
    etaAtMs: nowMs + remainingMs,
    avgTaskDurationMs,
    ...base,
  };
}

export function workloadExtent(
  rows: readonly NodeStateRow[],
  treeNodes: ReadonlyArray<{ kind?: unknown; agent?: unknown }> | undefined,
  runStartedAtMs: number | undefined,
  nowMs: number,
) {
  const classified = classifyEntries(rows.map((row) => ({ ...row, key: `${row.nodeId}#${row.iteration}` })));
  const agentTasks = treeNodes === undefined ? undefined : treeNodes.filter((node) => {
    const kind = asString(node.kind)?.toLowerCase();
    // GatewayRunNode maps real <Task agent={...}> nodes to kind "agent";
    // retain the old task + agent shape for legacy gateway rows.
    return kind === "agent" || (kind === "task" && (typeof node.agent === "string" ? node.agent.length > 0 : isRecord(node.agent)));
  }).length;
  return {
    totalKnown: rows.length,
    settled: classified.settled.length,
    running: classified.inFlight.length,
    pending: classified.remaining.length,
    ...(agentTasks !== undefined ? { agentTasks } : {}),
    ...(runStartedAtMs !== undefined ? { elapsedMs: Math.max(0, nowMs - runStartedAtMs) } : {}),
    atLeast: hasOpenEndedWork(rows, treeNodes),
  };
}

export function etaRefreshMs(runStatus: string | undefined): number | null {
  return isTerminalStatus(runStatus) ? null : 3_000;
}

export function formatEta(estimate: ReturnType<typeof estimateRun>): string {
  if (estimate.kind === "unknown") return "estimating…";
  const phrase = `~${formatDurationMs(estimate.remainingMs)} left`;
  return estimate.kind === "at-least" ? `at least ${phrase}` : phrase;
}

/** Compact form for facts-band cells: the value alone, never inline prose. */
export function formatEtaShort(estimate: ReturnType<typeof estimateRun>): string {
  if (estimate.kind === "unknown") return "estimating…";
  const duration = formatDurationMs(estimate.remainingMs);
  return estimate.kind === "at-least" ? `≥${duration}` : `~${duration}`;
}
