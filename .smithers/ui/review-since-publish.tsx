/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayRunEvents, useGatewayRuns } from "smithers-orchestrator/gateway-react";
import { NodeOutputView, RunEventLog, RunTree, StatusPill, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "review-since-publish";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

export function reviewEventInfo(value: unknown): { event: string; nodeId: string } {
  const frame = isRecord(value) ? value : {};
  const outerPayload = isRecord(frame.payload) ? frame.payload : {};
  const wrapped = frame.event === "run.event" && typeof outerPayload.event === "string" ? outerPayload : frame;
  const payload = isRecord(wrapped.payload) ? wrapped.payload : {};
  return {
    event: typeof wrapped.event === "string" ? wrapped.event : "",
    nodeId: typeof payload.nodeId === "string" ? payload.nodeId : "",
  };
}

export function reviewProgress(events: readonly unknown[]): { rounds: number; fixLanes: number } {
  const normalized = events.map(reviewEventInfo);
  const rounds = normalized.filter(
    (event) => (event.event === "NodeFinished" || event.event === "node.finished") && event.nodeId.startsWith("merge"),
  ).length;
  const fixLanes = new Set(normalized.map((event) => event.nodeId).filter((nodeId) => nodeId.startsWith("fix:"))).size;
  return { rounds, fixLanes };
}

export function ReviewSincePublishPanel() {
  const urlRunId = runIdFromUrl();
  const runsRaw = useGatewayRuns({ filter: { workflow: WORKFLOW_KEY, limit: 20 } });
  const runs = (runsRaw.data ?? []) as { runId: string; status?: string; workflowKey?: string }[];
  const active = urlRunId ? runs.find((r) => r.runId === urlRunId) : runs[0];
  const runId = urlRunId ?? active?.runId;
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const { events } = useGatewayRunEvents(runId, { maxEvents: 500 });

  // Round + lane progress are derivable from the normalized event stream:
  // durable rows are flat, while live lifecycle events use a run.event
  // envelope with the node payload nested one level deeper.
  const { rounds, fixLanes } = reviewProgress(events);

  return (
    <WorkflowUiShell
      title="Review Since Publish"
      meta={
        <>
          <StatusPill status={active?.status} />
          <span className="chip">{runId ? runId.slice(0, 8) : "no run"}</span>
          <span className="chip">codex/sol · kimi k3 · claude fable</span>
          <span className="chip">rounds merged: {rounds}</span>
          <span className="chip">fix lanes: {fixLanes}</span>
        </>
      }
      testId="review-since-publish-ui"
    >
      <div className="workflow-detail">
        <section className="panel">
          <div className="section-head">Nodes</div>
          <RunTree runId={runId} activeNodeId={selectedNodeId} onSelectNode={(n) => setSelectedNodeId(n.id)} />
        </section>
        <section className="panel">
          <div className="section-head">Events</div>
          <RunEventLog runId={runId} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} />
        </section>
      </div>
      {selectedNodeId ? (
        <section className="panel">
          <div className="section-head">{selectedNodeId}</div>
          <NodeOutputView runId={runId} nodeId={selectedNodeId} />
        </section>
      ) : null}
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<ReviewSincePublishPanel />);
