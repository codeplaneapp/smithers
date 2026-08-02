/** @jsxImportSource react */
/**
 * Live UI for the shared-ui-library extraction swarm: inventory + discovery
 * phase chips, one card per extraction ticket lane (implement → validate →
 * review loop, merge state), the CI gate, the batch audit, and the raw event
 * stream. Composed from the shipped gateway-ui components over gateway-react
 * hooks.
 */
import React, { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRuns,
  useGatewayRunTree,
} from "smthrs/gateway-react";
import {
  ApprovalPanel,
  RunEventLog,
  StatusPill,
  WorkflowUiShell,
  WorkflowUiStyles,
  formatStatus,
} from "smthrs/gateway-ui";
import { EmptyState } from "smthrs/ui";

const WORKFLOW_KEY = "shared-ui-library";

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(128,128,128,0.25)",
  borderRadius: 8,
  padding: 12,
};

const PHASES: Array<{ prefix: string; label: string }> = [
  { prefix: "inventory-shared-packages", label: "inventory: shared" },
  { prefix: "inventory-smithers-surfaces", label: "inventory: .smithers" },
  { prefix: "inventory-multi-app", label: "inventory: multi" },
  { prefix: "discover-batch", label: "discover" },
  { prefix: "ci-gate", label: "ci gate" },
  { prefix: "final-audit", label: "audit" },
];

const STAGES: Array<{ suffix: "implement" | "validate" | "review"; label: string }> = [
  { suffix: "implement", label: "opus implement" },
  { suffix: "validate", label: "validate" },
  { suffix: "review", label: "opus review" },
];

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

/** Latest status among tree nodes whose base id matches exactly (loop iterations repeat ids). */
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

/** Extraction lanes discovered from tree node ids: ticket-<slug>-implement|validate|review|result. */
function laneSlugs(nodes: TreeNode[]): string[] {
  const slugs = new Set<string>();
  for (const node of nodes) {
    const match = /^ticket-(.+)-(implement|validate|review|result)$/.exec(baseId(String(node.id ?? "")));
    if (match) slugs.add(match[1]);
  }
  return [...slugs].sort();
}

function StageDot({ status, label }: { status: string | undefined; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 10, fontSize: 12 }} title={label}>
      <StatusPill status={status ?? "pending"} />
      <span style={{ opacity: 0.75 }}>{label}</span>
    </span>
  );
}

function TicketCard({ runId, slug, nodes }: { runId: string; slug: string; nodes: TreeNode[] }) {
  const [open, setOpen] = useState(false);
  const result = latestStatus(nodes, `ticket-${slug}-result`);
  const merge = latestStatus(nodes, `merge-${slug}`);
  const resultQuery = useGatewayNodeOutput({ runId, nodeId: result.fullId ?? `ticket-${slug}-result`, iteration: 0 });
  const row = isRecord(resultQuery.data) && isRecord(resultQuery.data.row) ? resultQuery.data.row : undefined;
  const lgtm = row?.lgtm === true || row?.lgtm === 1;
  const settled = row !== undefined;
  const verdict = merge.status === "ok" ? "merged" : settled ? (lgtm ? "lgtm" : "not lgtm") : undefined;
  return (
    <div style={panelStyle}>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <strong style={{ fontSize: 13 }}>{slug}</strong>
        <span style={{ marginLeft: "auto", fontSize: 12 }}>
          {verdict ? <StatusPill status={verdict === "merged" || verdict === "lgtm" ? "finished" : "failed"} /> : null}
          {verdict ? <span style={{ marginLeft: 6, opacity: 0.75 }}>{verdict}</span> : null}
        </span>
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" }}>
        {STAGES.map((stage) => (
          <StageDot
            key={stage.suffix}
            status={latestStatus(nodes, `ticket-${slug}-${stage.suffix}`).status}
            label={stage.label}
          />
        ))}
        <StageDot status={merge.status} label="merge" />
      </div>
      {open && row !== undefined ? (
        <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.85 }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function PhaseStrip({ nodes }: { nodes: TreeNode[] }) {
  return (
    <div style={{ ...panelStyle, display: "flex", flexWrap: "wrap", alignItems: "center" }}>
      {PHASES.map((phase) => (
        <StageDot key={phase.prefix} status={latestStatus(nodes, phase.prefix).status} label={phase.label} />
      ))}
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
  const approvalsQuery = useGatewayApprovals();
  const nodes = useMemo(() => (Array.isArray(tree.nodes) ? (tree.nodes as TreeNode[]) : []), [tree.nodes]);
  const slugs = useMemo(() => laneSlugs(nodes), [nodes]);
  const status = isRecord(runQuery.data) ? String(runQuery.data.status ?? "") : "";
  const batches = useMemo(() => {
    let max = 0;
    for (const node of nodes) {
      const match = /@@shared-ui-batches=(\d+)/.exec(String(node.id ?? ""));
      if (match) max = Math.max(max, Number(match[1]) + 1);
    }
    return max;
  }, [nodes]);
  const pendingApprovals = (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []).filter(
    (a: unknown) => isRecord(a) && a.runId === runId,
  ).length;

  if (!runId) {
    return (
      <WorkflowUiShell title="Shared UI Library Swarm">
        <EmptyState title="No run yet" description="Launch with: smithers workflow run shared-ui-library" />
      </WorkflowUiShell>
    );
  }
  return (
    <WorkflowUiShell
      title="Shared UI Library Swarm"
      meta={`${runId.slice(0, 8)} · ${formatStatus(status)}${batches ? ` · batch ${batches}` : ""}${pendingApprovals ? ` · ${pendingApprovals} approval(s) waiting` : ""}`}
    >
      <div style={{ marginBottom: 12 }}>
        <PhaseStrip nodes={nodes} />
      </div>
      {slugs.length === 0 ? (
        <div style={{ marginBottom: 12 }}>
          <EmptyState
            title="No extraction lanes yet"
            description="Lanes appear once discovery returns the batch tickets."
          />
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 10,
            marginBottom: 12,
          }}
        >
          {slugs.map((slug) => (
            <TicketCard key={slug} runId={runId} slug={slug} nodes={nodes} />
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)", gap: 12 }}>
        <ApprovalPanel filter={{ workflow: WORKFLOW_KEY }} />
        <RunEventLog runId={runId} maxEvents={200} />
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(
  <>
    <WorkflowUiStyles />
    <App />
  </>,
);
