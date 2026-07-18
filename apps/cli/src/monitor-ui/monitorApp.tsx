/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useGatewayApprovals, useGatewayConnectionStatus, useGatewayRuns } from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import { SmithersUiStyles } from "smithers-orchestrator/ui";
// Inlined at bundle time (Bun.build) — the gateway serves one self-contained
// client.js, so the stylesheet ships as a string appended to monitorCss.
import xtermCss from "@xterm/xterm/css/xterm.css" with { type: "text" };
import {
  embedModeFromSearch,
  filterRuns,
  isTerminalStatus,
  selectionSinkFor,
  statusOptions,
  treeNodeKey,
  workflowOptions,
  type RunRow,
} from "./monitorModel.ts";
import { Chip, MonitorToolbar } from "./monitorShell.tsx";
import { monitorCss } from "./monitorCss.ts";
import type { TreeNode } from "./monitorExecution.tsx";
import { MetricsPanel } from "./monitorMetrics.tsx";
import { NodeInspector } from "./monitorNodeInspector.tsx";
import { CronsPanel, OpsStrip } from "./monitorOps.tsx";
import { RunDetail } from "./monitorRunDetail.tsx";
import { ApprovalsInbox, RunsRail, RunsTable } from "./monitorRuns.tsx";
import { useRunScores } from "./monitorScores.tsx";
import { ConnectionBadge, useNowMs } from "./monitorShared.tsx";
import { AttentionBannerView } from "./monitorAttentionBanner.tsx";
import { workspaceAttention } from "./monitorAttentionModel.ts";

export const monitorMode = embedModeFromSearch(typeof location === "undefined" ? "" : location.search);

function emitSelection(runId: string | undefined, nodeId: string | undefined): void {
  const sink = selectionSinkFor(monitorMode, runId, nodeId);
  if (sink.kind === "url") {
    writeUrlSelection(sink.runId, sink.nodeId);
  } else if (sink.kind === "postMessage" && typeof window !== "undefined") {
    window.parent.postMessage(sink.message, sink.targetOrigin);
  }
}

function writeUrlSelection(runId: string | undefined, nodeId: string | undefined): void {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const params = new URLSearchParams(location.search);
  if (runId) params.set("runId", runId);
  else params.delete("runId");
  if (nodeId) params.set("nodeId", nodeId);
  else params.delete("nodeId");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

/**
 * The Monitor's top-level composition seam. Later panel lanes plug in here
 * while keeping their implementations isolated in the focused panel modules.
 */
// ---------------------------------------------------------------------------
// App shell.
// ---------------------------------------------------------------------------

export function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<TreeNode | undefined>(undefined);
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { status: connStatus } = useGatewayConnectionStatus();
  // No offset/cursor in the gateway's ListRunsRequest filter, so fetch a wide
  // window and let the landing table paginate client-side (RUNS_PAGE_SIZE).
  const runsQuery = useGatewayRuns({ filter: { limit: 1000 } });
  const allRuns = (runsQuery.data ?? []) as RunRow[];
  const approvals = useGatewayApprovals().data ?? [];
  const now = useNowMs();
  const attention = useMemo(() => workspaceAttention(allRuns, approvals, now), [allRuns, approvals, now]);
  const [runsPage, setRunsPage] = useState(1);
  const selectedRun = allRuns.find((run) => run.runId === selectedRunId);
  const scores = useRunScores(selectedRunId, !isTerminalStatus(selectedRun?.status));

  // Resolve ?runId=&nodeId= once, when runs first arrive. An unknown id still
  // selects (RunDetail renders an honest "Run not found" state).
  const urlResolved = useRef(false);
  const initialNodeId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (urlResolved.current || (!monitorMode.runId && allRuns.length === 0)) return;
    urlResolved.current = true;
    if (monitorMode.runId) {
      setSelectedRunId(monitorMode.runId);
      initialNodeId.current = monitorMode.nodeId;
    }
  }, [allRuns.length]);

  const selectRun = (runId: string | undefined) => {
    setSelectedRunId(runId);
    setSelectedNode(undefined);
    // Picking a run means "show me the run" — leave the metrics view.
    setShowMetrics(false);
    emitSelection(runId, undefined);
  };
  const selectNode = (node: TreeNode | undefined) => {
    setSelectedNode(node);
    emitSelection(selectedRunId, node ? (node.id ?? treeNodeKey(node)) : undefined);
  };

  const showResult = (kind: "ok" | "err", text: string) => {
    setBanner({ kind, text });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    if (kind === "ok") bannerTimer.current = setTimeout(() => setBanner(null), 4000);
  };

  const visibleRuns = useMemo(
    () => filterRuns(allRuns, { text: filterText, status: statusFilter, workflow: workflowFilter }),
    [allRuns, filterText, statusFilter, workflowFilter],
  );
  // A changed filter means a new result set: land back on its first page.
  useEffect(() => {
    setRunsPage(1);
  }, [filterText, statusFilter, workflowFilter]);
  const workflows = useMemo(() => workflowOptions(allRuns), [allRuns]);
  const statuses = useMemo(() => statusOptions(allRuns), [allRuns]);

  return (
    <main className={`mon-shell${monitorMode.embed ? " mon-embed" : ""}`} data-testid="monitor-root">
      <WorkflowUiStyles mode="theme" />
      <SmithersUiStyles extra={`${monitorCss}\n${xtermCss}`} />
      {!monitorMode.embed ? <header className="mon-topbar">
        <div className="mon-brand">
          <span className="mon-brand-mark" aria-hidden />
          <h1>Smithers Monitor</h1>
          <ConnectionBadge />
        </div>
        <MonitorToolbar
          filterText={filterText}
          onFilterText={setFilterText}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          statuses={statuses}
          workflowFilter={workflowFilter}
          onWorkflowFilter={setWorkflowFilter}
          workflows={workflows}
          visibleCount={visibleRuns.length}
          totalCount={allRuns.length}
          showMetrics={showMetrics}
          onToggleMetrics={() => setShowMetrics((value) => !value)}
          onRefresh={() => void runsQuery.refetch()}
        />
      </header> : null}

      {banner ? (
        <div className={`mon-banner mon-banner-app tone-${banner.kind === "ok" ? "ok" : "failed"}`} role="status">
          {banner.text}
          <Chip onClick={() => setBanner(null)}>Dismiss</Chip>
        </div>
      ) : null}

      <div className="mon-body">
        {!monitorMode.embed ? <div className="mon-rail">
          <ApprovalsInbox onSelectRun={selectRun} onResult={showResult} />
          <RunsRail
            runs={visibleRuns}
            loading={runsQuery.loading ?? false}
            connStatus={connStatus}
            selectedRunId={selectedRunId}
            onSelect={selectRun}
          />
        </div> : null}

        <div className="mon-main">
          {showMetrics ? (
            <MetricsPanel />
          ) : selectedRunId ? (
            <RunDetail
              runId={selectedRunId}
              scores={scores}
              onResult={showResult}
              selectedNode={selectedNode}
              onSelectNode={selectNode}
              autoSelectNodeId={initialNodeId.current}
              onAutoSelected={() => {
                initialNodeId.current = undefined;
              }}
            />
          ) : (
            <div className="mon-overview">
              <AttentionBannerView items={attention.items.slice(0, 8)} total={attention.total} onSelectRun={selectRun} />
              <OpsStrip runs={allRuns} loading={runsQuery.loading ?? false} attentionTotal={attention.total} />
              <RunsTable
                runs={visibleRuns}
                loading={runsQuery.loading ?? false}
                page={runsPage}
                onPageChange={setRunsPage}
                onSelect={selectRun}
              />
              <CronsPanel />
            </div>
          )}
        </div>

        {!monitorMode.embed && selectedRunId && selectedNode ? (
          <NodeInspector runId={selectedRunId} node={selectedNode} scores={scores} onResult={showResult} />
        ) : null}
      </div>
    </main>
  );
}
