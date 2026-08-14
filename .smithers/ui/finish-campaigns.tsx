/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { createGatewayReactRoot, useGatewayNodeOutput, useGatewayRunTree } from "smthrs/gateway-react";
import { ApprovalPanel, ConnectionBadge, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
type GatewayRunNode = ReturnType<typeof useGatewayRunTree>["nodes"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowOf(value: unknown): Record<string, unknown> {
  const rec = isRecord(value) ? value : {};
  const data = isRecord(rec.data) ? rec.data : rec;
  return isRecord(data.row) ? data.row : data;
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

const layout = [
  ".fc-lanes { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; }",
  ".fc-lane-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }",
  ".fc-lane-agent { color:var(--muted,#a1a1aa); font-size:12px; }",
  ".fc-list { margin:8px 0 0; padding-left:18px; display:grid; gap:4px; }",
  ".fc-evidence { white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; color:var(--muted,#a1a1aa); max-height:120px; overflow:auto; margin-top:8px; }",
  ".fc-cols { display:grid; grid-template-columns:minmax(280px,1fr) minmax(320px,1.4fr); gap:14px; align-items:start; }",
  "@media (max-width: 900px) { .fc-cols { grid-template-columns:1fr; } }",
].join("\n");

function latestIteration(
  nodes: ReadonlyArray<GatewayRunNode>,
  nodeId: string,
): { iteration: number; status: string | undefined } {
  const rows = nodes.filter((node) => node.id === nodeId);
  if (rows.length === 0) return { iteration: 0, status: undefined };
  const latest = rows.reduce((best, node) => ((node.iteration ?? 0) >= (best.iteration ?? 0) ? node : best));
  return { iteration: latest.iteration ?? 0, status: latest.status };
}

function LaneCard(props: {
  runId: string | undefined;
  title: string;
  agentLabel: string;
  workNodeId: string;
  verifyNodeId: string;
  nodes: ReadonlyArray<GatewayRunNode>;
}) {
  const work = latestIteration(props.nodes, props.workNodeId);
  const verify = latestIteration(props.nodes, props.verifyNodeId);
  const verifyOutput = useGatewayNodeOutput({
    runId: props.runId,
    nodeId: props.verifyNodeId,
    iteration: verify.iteration,
  });
  const row = rowOf(verifyOutput.data);
  const done = row.done === true;
  const remaining = Array.isArray(row.remaining) ? (row.remaining as unknown[]).map(String) : [];
  const evidence = typeof row.evidence === "string" ? row.evidence : "";
  const laneStatus = done ? "ok" : (work.status ?? verify.status ?? "waiting");

  return (
    <section className="card">
      <div className="fc-lane-head">
        <div>
          <strong>{props.title}</strong>
          <div className="fc-lane-agent">{props.agentLabel}</div>
        </div>
        <StatusPill status={laneStatus} label={done ? "Done" : undefined} />
      </div>
      <div className="fc-lane-agent" style={{ marginTop: 8 }}>
        work: <StatusPill status={work.status ?? "pending"} /> · verify iter {verify.iteration}:{" "}
        <StatusPill status={verify.status ?? "pending"} />
      </div>
      {remaining.length > 0 ? (
        <ul className="fc-list">
          {remaining.map((item, index) => (
            <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <div className="fc-lane-agent" style={{ marginTop: 8 }}>
          {done ? "Campaign section complete." : "No verification report yet."}
        </div>
      )}
      {evidence ? <div className="fc-evidence">{evidence}</div> : null}
    </section>
  );
}

function App() {
  const runId = runIdFromUrl();
  const tree = useGatewayRunTree(runId);
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>();
  const nodes = tree.nodes;
  const runStatus = useMemo(() => tree.status, [tree.status]);

  return (
    <WorkflowUiShell
      title="Finish Campaigns"
      meta={<StatusPill status={runStatus} />}
      actions={
        <>
          <span className="pill">{runId ?? "no run selected"}</span>
          <ConnectionBadge className="chip" />
        </>
      }
    >
      <style>{layout}</style>
      <div className="fc-lanes">
        <LaneCard
          runId={runId}
          title="Campaign 1 · Testing framework"
          agentLabel="codex sol (fable while codex is paused)"
          workNodeId="tf-work"
          verifyNodeId="tf-verify"
          nodes={nodes}
        />
        <LaneCard
          runId={runId}
          title="Campaign 2 · Shared UI library"
          agentLabel="opencode · kimi-for-coding/k3"
          workNodeId="ui-work"
          verifyNodeId="ui-verify"
          nodes={nodes}
        />
      </div>
      <ApprovalPanel filter={runId ? { runId } : undefined} />
      <div className="fc-cols">
        <RunTree runId={runId} activeNodeId={activeNodeId} onSelectNode={(node) => setActiveNodeId(node.id)} />
        <RunEventLog runId={runId} />
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
