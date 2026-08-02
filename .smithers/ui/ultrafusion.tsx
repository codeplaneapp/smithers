/** @jsxImportSource react */
/**
 * Ultrafusion — live dashboard (presentation-only).
 * Four blind lanes → fusion → leaderboard, composed from the shipped
 * gateway-ui widgets + ui primitives over the gateway-react hooks.
 */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayNodeOutput } from "smthrs/gateway-react";
import {
  ConnectionBadge,
  MonitorButton,
  NodeChatStream,
  NodeOutputView,
  RunEventLog,
  RunList,
  RunMeta,
  RunTree,
  StatusPill,
  WorkflowUiShell,
} from "smthrs/gateway-ui";
import { EmptyState, KpiStat } from "smthrs/ui";

const WORKFLOW = "ultrafusion";
const LETTERS = ["A", "B", "C", "D"];

function initialRunId(): string | undefined {
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

/** One lane card: anonymous while running; identity + points appear once the
 *  post-fusion roster/score rows exist (the run itself stays blind). */
function LaneKpi({ runId, letter }: { runId?: string; letter: string }) {
  const lane = useGatewayNodeOutput({ runId, nodeId: `lane-${letter}`, iteration: 0 });
  const score = useGatewayNodeOutput({ runId, nodeId: `score-${letter}`, iteration: 0 });
  const laneRow = (lane.data as any)?.row ?? null;
  const scoreRow = (score.data as any)?.row ?? null;
  const status = laneRow ? "finished" : String((lane.data as any)?.status ?? "pending");
  return (
    <KpiStat
      label={`lane ${letter}${scoreRow ? ` · ${scoreRow.agentKey}` : ""}`}
      value={scoreRow ? `${scoreRow.points} pts` : <StatusPill status={status} />}
      hint={scoreRow ? String(scoreRow.verdictNote) : laneRow ? "delivered — awaiting blind fusion" : "blind lane"}
    />
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(initialRunId());
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const fusion = useGatewayNodeOutput({ runId, nodeId: "fusion", iteration: 0 });
  const fused = (fusion.data as any)?.row ?? null;

  return (
    <WorkflowUiShell
      title="Ultrafusion — blind lanes, fused verdict"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {LETTERS.map((L) => (
            <LaneKpi key={L} runId={runId} letter={L} />
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 1fr", gap: 12 }}>
          <RunList
            filter={{ workflow: WORKFLOW, limit: 20 }}
            activeRunId={runId}
            onSelect={(id: string) => {
              setRunId(id);
              setNodeId(undefined);
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <RunTree runId={runId} activeNodeId={nodeId} onSelectNode={(node: { id: string }) => setNodeId(node.id)} />
            <RunEventLog runId={runId} style={{ height: 220 }} selectedNodeId={nodeId} onSelectNode={setNodeId} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {fused ? (
              <NodeOutputView runId={runId} nodeId="artifact" />
            ) : (
              <EmptyState
                title="No fused verdict yet"
                description="The blind fusion runs after at least two lanes deliver. Watch a lane's live chat by selecting its node."
              />
            )}
            {nodeId ? <NodeChatStream runId={runId} nodeId={nodeId} /> : null}
            <NodeOutputView runId={runId} nodeId="fusion" />
          </div>
        </div>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
