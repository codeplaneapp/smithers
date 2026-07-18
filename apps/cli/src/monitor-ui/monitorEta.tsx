/** @jsxImportSource react */
import { useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import { buildTimeline, formatDurationMs, isTerminalStatus, nodeStateRowsOf, type RunRow } from "./monitorModel.ts";
import { estimateRun, etaRefreshMs, formatEta, hasOpenEndedWork, workloadExtent } from "./monitorEtaModel.ts";
import { useJsonApi, useNowMs } from "./monitorShared.tsx";

type Estimate = ReturnType<typeof estimateRun>;
type Extent = ReturnType<typeof workloadExtent>;

export function RunEtaLineView({ estimate, extent, showEstimate = true }: { estimate: Estimate; extent: Extent; showEstimate?: boolean }) {
  const tasks = extent.atLeast ? `${extent.settled} settled · at least ${extent.totalKnown} known tasks` : `${extent.settled}/${extent.totalKnown} tasks`;
  const agentTasks = extent.agentTasks === undefined ? "" : ` · ${extent.agentTasks} agent task${extent.agentTasks === 1 ? "" : "s"}`;
  return <div className="mon-dim mon-mono">{showEstimate ? <>{formatEta(estimate)} · </> : null}{tasks}{agentTasks}{extent.elapsedMs !== undefined ? ` · ${formatDurationMs(extent.elapsedMs)} elapsed` : ""}</div>;
}

export function RunEtaLine({ runId, runStatus, startedAtMs, finishedAtMs }: { runId: string; runStatus: string | undefined; startedAtMs: number | undefined; finishedAtMs: number | undefined }) {
  const { body, loaded } = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/node-states`, etaRefreshMs(runStatus));
  const tree = useGatewayRunTree(runId);
  const now = useNowMs();
  if (!loaded) return null;
  const rows = nodeStateRowsOf(body);
  // An empty collection is only a real zero once the tree query is ready.
  // Until then, omit the agent count instead of briefly claiming there are none.
  const nodes = tree.isLoading || tree.error ? undefined : tree.nodes;
  const extent = workloadExtent(rows, nodes, startedAtMs, finishedAtMs ?? now);
  return <RunEtaLineView estimate={estimateRun(buildTimeline(rows, now), now, { openEnded: extent.atLeast })} extent={extent} showEstimate={!isTerminalStatus(runStatus)} />;
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
  return estimate.kind === "unknown" ? <span className="mon-dim">—</span> : <span className="mon-mono">{formatEta(estimate)}</span>;
}
