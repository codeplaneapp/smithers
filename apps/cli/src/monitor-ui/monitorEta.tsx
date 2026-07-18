/** @jsxImportSource react */
import { buildTimeline, formatDurationMs, isTerminalStatus, nodeStateRowsOf, type RunRow } from "./monitorModel.ts";
import { estimateRun, etaRefreshMs, formatEtaShort, hasOpenEndedWork, workloadExtent } from "./monitorEtaModel.ts";
import { FactCell, useJsonApi, useNowMs } from "./monitorShared.tsx";

type Estimate = ReturnType<typeof estimateRun>;
type Extent = ReturnType<typeof workloadExtent>;

/**
 * The ETA/Tasks/Elapsed cells of the header facts band. Values are compact
 * numerics ("~8m", "0/5+", "10m 46s") — labels carry the words, so the
 * header never renders an inline prose dot-chain.
 */
export function EtaFactCells({ estimate, extent, showEstimate = true }: { estimate: Estimate; extent: Extent; showEstimate?: boolean }) {
  const tasksValue = `${extent.settled}/${extent.totalKnown}${extent.atLeast ? "+" : ""}`;
  const agentSub = extent.agentTasks === undefined ? undefined : `${extent.agentTasks} agent`;
  return (
    <>
      {showEstimate ? (
        <FactCell
          value={formatEtaShort(estimate)}
          label="eta"
          sub={estimate.kind === "at-least" ? "lower bound" : undefined}
          testId="monitor-fact-eta"
        />
      ) : null}
      <FactCell value={tasksValue} label="tasks settled" sub={agentSub} testId="monitor-fact-tasks" />
      {extent.elapsedMs !== undefined ? (
        <FactCell value={formatDurationMs(extent.elapsedMs)} label="elapsed" testId="monitor-fact-elapsed" />
      ) : null}
    </>
  );
}

export function RunEtaCell({ run }: { run: RunRow }) {
  const now = useNowMs();
  const terminal = isTerminalStatus(run.status);
  const { body, loaded } = useJsonApi(
    terminal ? null : `/v1/api/runs/${encodeURIComponent(run.runId)}/node-states`,
    etaRefreshMs(run.status),
  );
  if (terminal || !loaded) return <span className="mon-dim">—</span>;
  const rows = nodeStateRowsOf(body);
  // The table deliberately uses the same measured node pace as the detail
  // header. It has no tree subscription, but iterations still make its ETA a
  // lower bound; loop/foreach kinds are additionally detected in the header.
  const estimate = estimateRun(buildTimeline(rows, now), now, { openEnded: hasOpenEndedWork(rows) });
  return estimate.kind === "unknown" ? <span className="mon-dim">—</span> : <span className="mon-mono">{formatEtaShort(estimate)}</span>;
}
