/** @jsxImportSource react */
/**
 * Live UI for the monitor-redesign swarm: one card per lane showing where it
 * sits in the sol-plan → fable-plan-review → terra/sol build loop →
 * fable-final pipeline, plus merge state, the verify gate, the human test
 * approval, and the raw event stream. Composed from the shipped gateway-ui
 * components over gateway-react hooks.
 */
import React, { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRuns,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
  RunEventLog,
  StatusPill,
  WorkflowUiShell,
  WorkflowUiStyles,
  formatStatus,
} from "smithers-orchestrator/gateway-ui";
import { EmptyState } from "smithers-orchestrator/ui";

const panelStyle: React.CSSProperties = {
  border: "1px solid rgba(128,128,128,0.25)",
  borderRadius: 8,
  padding: 12,
};

const WORKFLOW_KEY = "monitor-redesign";

const LANES: Array<{ id: string; title: string }> = [
  { id: "shell-split", title: "Split the monolith (serial)" },
  { id: "usage-cost", title: "Cost & subscription burn" },
  { id: "eta-progress", title: "Honest ETA & extent" },
  { id: "health-attention", title: "Health & attention" },
  { id: "run-recap", title: "Run-level AI recap" },
  { id: "footprint", title: "Codebase footprint" },
  { id: "decisions", title: "Decisions ledger" },
  { id: "integrate", title: "Single-surface integration (serial)" },
];

const STAGES: Array<{ suffix: string; label: string }> = [
  { suffix: "plan", label: "sol plan" },
  { suffix: "plan-review", label: "fable plan review" },
  { suffix: "implement", label: "terra implement" },
  { suffix: "review", label: "sol review" },
  { suffix: "final-review", label: "fable final" },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

/** Latest tree node whose id starts with `<laneId>-<suffix>` (loop iterations repeat ids). */
function laneStageStatus(nodes: Array<Record<string, unknown>>, laneId: string, suffix: string): string | undefined {
  const wanted = `${laneId}-${suffix}`;
  let status: string | undefined;
  for (const node of nodes) {
    const id = String(node.id ?? "");
    if (id === wanted || id.startsWith(`${wanted}@@`)) status = String(node.status ?? "") || status;
  }
  return status;
}

function StageDot({ status, label }: { status: string | undefined; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 10, fontSize: 12 }} title={label}>
      <StatusPill status={status ?? "pending"} />
      <span style={{ opacity: 0.75 }}>{label}</span>
    </span>
  );
}

function LaneCard({
  runId,
  laneId,
  title,
  nodes,
}: {
  runId: string;
  laneId: string;
  title: string;
  nodes: Array<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const resultQuery = useGatewayNodeOutput({ runId, nodeId: `${laneId}-result`, iteration: 0 });
  const row = isRecord(resultQuery.data) && isRecord(resultQuery.data.row) ? resultQuery.data.row : undefined;
  const stages = STAGES.map((stage) => ({ ...stage, status: laneStageStatus(nodes, laneId, stage.suffix) }));
  const active = stages.filter((stage) => stage.status !== undefined);
  const laneVerdict =
    row !== undefined
      ? row.ready === true || row.ready === 1
        ? "ready"
        : "rejected"
      : active.length === 0
        ? "queued"
        : undefined;
  return (
    <div style={panelStyle}>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <code style={{ fontSize: 11, opacity: 0.6 }}>{laneId}</code>
        <span style={{ marginLeft: "auto" }}>
          {laneVerdict ? (
            <StatusPill
              status={laneVerdict === "ready" ? "finished" : laneVerdict === "rejected" ? "failed" : "pending"}
            />
          ) : null}
        </span>
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" }}>
        {stages.map((stage) => (
          <StageDot key={stage.suffix} status={stage.status} label={stage.label} />
        ))}
      </div>
      {open && row !== undefined ? (
        <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap", opacity: 0.85 }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function GateRow({ runId }: { runId: string }) {
  const verify = useGatewayNodeOutput({ runId, nodeId: "verify", iteration: 0 });
  const ship = useGatewayNodeOutput({ runId, nodeId: "ship", iteration: 0 });
  const verifyRow = isRecord(verify.data) && isRecord(verify.data.row) ? verify.data.row : undefined;
  const shipRow = isRecord(ship.data) && isRecord(ship.data.row) ? ship.data.row : undefined;
  return (
    <div style={{ ...panelStyle, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12 }}>
        Verify gate:{" "}
        <StatusPill
          status={
            verifyRow === undefined
              ? "pending"
              : verifyRow.allPassed === true || verifyRow.allPassed === 1
                ? "finished"
                : "failed"
          }
        />
      </span>
      <span style={{ fontSize: 12 }}>
        Ship:{" "}
        <StatusPill
          status={
            shipRow === undefined ? "pending" : shipRow.ready === true || shipRow.ready === 1 ? "finished" : "failed"
          }
        />
      </span>
      {verifyRow !== undefined ? (
        <span style={{ fontSize: 11, opacity: 0.7 }}>{String(verifyRow.summary ?? "")}</span>
      ) : null}
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
  const nodes = useMemo(
    () => (Array.isArray(tree.nodes) ? (tree.nodes as Array<Record<string, unknown>>) : []),
    [tree.nodes],
  );
  const status = isRecord(runQuery.data) ? String(runQuery.data.status ?? "") : "";
  const pendingApprovals = (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []).filter(
    (a: unknown) => isRecord(a) && a.runId === runId,
  ).length;

  if (!runId) {
    return (
      <WorkflowUiShell title="Monitor Redesign Swarm">
        <EmptyState title="No run yet" description="Launch with: smithers workflow run monitor-redesign" />
      </WorkflowUiShell>
    );
  }
  return (
    <WorkflowUiShell
      title="Monitor Redesign Swarm"
      meta={`${runId.slice(0, 8)} · ${formatStatus(status)}${pendingApprovals ? ` · ${pendingApprovals} approval(s) waiting` : ""}`}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 10,
          marginBottom: 12,
        }}
      >
        {LANES.map((lane) => (
          <LaneCard key={lane.id} runId={runId} laneId={lane.id} title={lane.title} nodes={nodes} />
        ))}
      </div>
      <div style={{ marginBottom: 12 }}>
        <GateRow runId={runId} />
      </div>
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
