/** @jsxImportSource react */
/**
 * Operation Ferric — workflow UI (presentation-only; it cannot schedule work).
 * Declared by the workflow via `UI entry="../ui/react-rust-port.tsx"` and
 * composed from smithers-orchestrator/gateway-ui widgets + smithers-orchestrator/ui
 * primitives over the gateway-react hooks (spec §6).
 */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayRun } from "smithers-orchestrator/gateway-react";
import {
  ApprovalPanel,
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
} from "smithers-orchestrator/gateway-ui";
import { EmptyState, KpiStat } from "smithers-orchestrator/ui";

const WORKFLOW = "react-rust-port";
const MILESTONES = ["M0", "M1", "M2", "M3", "M4", "M5M6", "M7", "M8", "GA", "M9"];

function initialRunId(): string | undefined {
  return new URLSearchParams(window.location.search).get("runId") ?? undefined;
}

/** Which campaign milestone this run executes (input override or the
 *  ContinueAsNew continuation payload), plus live run status. */
function MilestoneRail({ runId }: { runId?: string }) {
  const run = useGatewayRun(runId);
  const input = (run.data as any)?.input ?? {};
  const current: string = input.milestone ?? input.__smithersContinuation?.payload?.milestone ?? "M0";
  const status = String((run.data as any)?.status ?? "unknown");
  const cur = MILESTONES.indexOf(current);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {MILESTONES.map((mName, idx) => (
        <StatusPill key={mName} status={idx < cur ? "finished" : idx === cur ? "running" : "pending"} label={mName} />
      ))}
      <span style={{ flex: 1 }} />
      <StatusPill status={status} label={`run ${status}`} />
    </div>
  );
}

function CampaignKpis({ runId }: { runId?: string }) {
  const run = useGatewayRun(runId);
  const input = (run.data as any)?.input ?? {};
  const cont = input.__smithersContinuation?.payload ?? {};
  const lineage: string[] = cont.lineage ?? [];
  const spentCents = Number(input.modelSpentCents ?? cont.spentCents ?? 0);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      <KpiStat label="Milestone" value={String(input.milestone ?? cont.milestone ?? "M0")} />
      <KpiStat label="Lineage runs" value={String(lineage.length + 1)} hint="ContinueAsNew chain" />
      <KpiStat
        label="Attested spend"
        value={`$${(spentCents / 100).toFixed(0)}`}
        hint="operator-attested; caps $200k pre-M8 / $250k"
      />
    </div>
  );
}

function App() {
  const [runId, setRunId] = useState<string | undefined>(initialRunId());
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);

  return (
    <WorkflowUiShell
      title="Operation Ferric — React runtime in Rust"
      meta={<RunMeta runId={runId} showConnection={false} />}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <ConnectionBadge />
          <MonitorButton runId={runId} />
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <MilestoneRail runId={runId} />
        <CampaignKpis runId={runId} />

        {/* The human's entire job surface: kill gates, go/no-go, spend, RC/GA,
            publishes, M9 freeze, ratchet halts. None auto-approve. */}
        <ApprovalPanel filter={{ workflow: WORKFLOW }} />

        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 1fr", gap: 12 }}>
          <RunList
            filter={{ workflow: WORKFLOW, limit: 25 }}
            activeRunId={runId}
            onSelect={(id: string) => {
              setRunId(id);
              setNodeId(undefined);
            }}
          />
          <RunTree runId={runId} activeNodeId={nodeId} onSelectNode={(node: { id: string }) => setNodeId(node.id)} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {nodeId ? (
              <NodeOutputView runId={runId} nodeId={nodeId} />
            ) : (
              <EmptyState
                title="No node selected"
                description="Pick a node in the tree or event log to see its output and live agent chat."
              />
            )}
            <RunEventLog runId={runId} style={{ height: 260 }} selectedNodeId={nodeId} onSelectNode={setNodeId} />
            {/* Live-feedback rule: every surfaced agent node gets a live chat. */}
            {nodeId ? <NodeChatStream runId={runId} nodeId={nodeId} /> : null}
          </div>
        </div>
      </div>
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
