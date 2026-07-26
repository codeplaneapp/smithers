/** @jsxImportSource react */
/**
 * Live UI for the land-shared-ui recovery merge train: one status chip per
 * worktree landing, the CI gate + fix rounds, the final landing report, and
 * the raw event stream. Composed from the shipped gateway-ui components over
 * gateway-react hooks.
 */
import React, { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRuns,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import {
  RunEventLog,
  StatusPill,
  WorkflowUiShell,
  WorkflowUiStyles,
  formatStatus,
} from "smithers-orchestrator/gateway-ui";
import { EmptyState } from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "land-shared-ui";

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(128,128,128,0.25)",
  borderRadius: 8,
  padding: 12,
};

type TreeNode = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function baseId(id: string): string {
  return id.split("@@", 1)[0] ?? id;
}

function latestStatus(nodes: TreeNode[], wanted: string): { status?: string; fullId?: string } {
  let status: string | undefined;
  let fullId: string | undefined;
  for (const node of nodes) {
    const id = String(node.id ?? "");
    if (baseId(id) === wanted) {
      status = String(node.status ?? "") || status;
      fullId = id;
    }
  }
  return { status, fullId };
}

function mergeSlugs(nodes: TreeNode[]): string[] {
  const slugs = new Set<string>();
  for (const node of nodes) {
    const match = /^merge-(.+)$/.exec(baseId(String(node.id ?? "")));
    if (match) slugs.add(match[1]);
  }
  return [...slugs].sort();
}

function MergeRow({ runId, slug, nodes }: { runId: string; slug: string; nodes: TreeNode[] }) {
  const [open, setOpen] = useState(false);
  const node = latestStatus(nodes, `merge-${slug}`);
  const outputQuery = useGatewayNodeOutput({ runId, nodeId: node.fullId ?? `merge-${slug}`, iteration: 0 });
  const row = isRecord(outputQuery.data) && isRecord(outputQuery.data.row) ? outputQuery.data.row : undefined;
  const merged = row?.merged === true || row?.merged === 1;
  const label = slug.replace(/^run-\d+-\d+-/, "");
  return (
    <div style={{ ...panelStyle, padding: 8 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}
        onClick={() => setOpen((v) => !v)}
      >
        <StatusPill status={row !== undefined ? (merged ? "finished" : "failed") : (node.status ?? "pending")} />
        <strong>{label}</strong>
        {row !== undefined ? <span style={{ opacity: 0.7 }}>{merged ? "landed" : "not landed"}</span> : null}
      </div>
      {open && row !== undefined ? (
        <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.85 }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function ReportPanel({ runId, nodes }: { runId: string; nodes: TreeNode[] }) {
  const node = latestStatus(nodes, "land-report");
  const reportQuery = useGatewayNodeOutput({ runId, nodeId: node.fullId ?? "land-report", iteration: 0 });
  const row = isRecord(reportQuery.data) && isRecord(reportQuery.data.row) ? reportQuery.data.row : undefined;
  if (row === undefined) return null;
  return (
    <div style={{ ...panelStyle, marginBottom: 12 }}>
      <strong style={{ fontSize: 13 }}>Landing report</strong>
      <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.85 }}>
        {JSON.stringify(row, null, 2)}
      </pre>
    </div>
  );
}

function App() {
  const urlRunId = runIdFromUrl();
  const runsQuery = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 10 } });
  const runs = Array.isArray(runsQuery.data) ? (runsQuery.data as Array<Record<string, unknown>>) : [];
  const runId = urlRunId ?? (runs[0] ? String(runs[0].runId ?? "") : undefined);
  const runQuery = useGatewayRun(runId ?? "");
  const tree = useGatewayRunTree(runId ?? "");
  const nodes = useMemo(() => (Array.isArray(tree.nodes) ? (tree.nodes as TreeNode[]) : []), [tree.nodes]);
  const slugs = useMemo(() => mergeSlugs(nodes), [nodes]);
  const status = isRecord(runQuery.data) ? String(runQuery.data.status ?? "") : "";
  const ci = latestStatus(nodes, "land-ci");
  const fix = latestStatus(nodes, "land-fix");

  if (!runId) {
    return (
      <WorkflowUiShell title="Land Shared UI Worktrees">
        <EmptyState title="No run yet" description="Launch with: smithers workflow run land-shared-ui" />
      </WorkflowUiShell>
    );
  }
  return (
    <WorkflowUiShell title="Land Shared UI Worktrees" meta={`${runId.slice(0, 8)} · ${formatStatus(status)}`}>
      <div style={{ ...panelStyle, display: "flex", gap: 16, alignItems: "center", marginBottom: 12, fontSize: 12 }}>
        <span>
          CI gate: <StatusPill status={ci.status ?? "pending"} />
        </span>
        {fix.status ? (
          <span>
            fix round: <StatusPill status={fix.status} />
          </span>
        ) : null}
      </div>
      <ReportPanel runId={runId} nodes={nodes} />
      {slugs.length === 0 ? (
        <EmptyState
          title="No merge lanes yet"
          description="Lanes appear as the merge queue schedules worktree landings."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 8,
            marginBottom: 12,
          }}
        >
          {slugs.map((slug) => (
            <MergeRow key={slug} runId={runId} slug={slug} nodes={nodes} />
          ))}
        </div>
      )}
      <RunEventLog runId={runId} maxEvents={200} />
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(
  <>
    <WorkflowUiStyles />
    <App />
  </>,
);
