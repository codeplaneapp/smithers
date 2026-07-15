/** @jsxImportSource react */
import { useMemo } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
} from "smithers-orchestrator/gateway-react";

type NodeStatus = "pending" | "running" | "done" | "failed" | "waiting" | "skipped";

const ITEMS: Array<{ key: string; kind: "hard" | "quick"; issues: number[]; title: string }> = [
  { key: "ci-postgres", kind: "hard", issues: [1331], title: "CI test-postgres red (PGlite migrate suites)" },
  { key: "e2e-orphans", kind: "hard", issues: [1332], title: "e2e harness leaks orphaned smithers up processes" },
  { key: "dual-react", kind: "hard", issues: [1333], title: "Gateway dual React instances at render" },
  { key: "url-schemes", kind: "quick", issues: [799, 911, 912], title: "Reject non-HTTP URL schemes (file:// exposure)" },
  { key: "pack-home", kind: "quick", issues: [1322], title: "Pack global root ignores env.HOME" },
  { key: "pack-scan", kind: "quick", issues: [1323], title: "Pack import scanner misses .js helpers" },
  { key: "workflow-dirs", kind: "quick", issues: [1324], title: "resolveWorkflowDirs local==global collapse" },
  { key: "dead-code", kind: "quick", issues: [1327], title: "Delete dead autoOpenMonitor" },
  { key: "mcp-confirm", kind: "quick", issues: [861, 862], title: "Confirmation for restore_checkpoint / time_travel" },
  { key: "coerce-props", kind: "quick", issues: [865, 866, 867], title: "Coerce numeric-string props in graph extraction" },
  { key: "audit-atomic", kind: "quick", issues: [872, 873, 874, 875, 876, 877, 878, 879, 880], title: "Atomic mutation + audit-event writes (×9)" },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  return isRecord(data.row) ? (data.row as Record<string, unknown>) : isRecord(data) ? data : null;
}
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Latest lifecycle status + iteration per nodeId, derived from the event stream. */
function buildNodeState(events: unknown[]): { status: Map<string, NodeStatus>; iteration: Map<string, number> } {
  const status = new Map<string, NodeStatus>();
  const iteration = new Map<string, number>();
  for (const raw of events) {
    const ev = isRecord(raw) ? (isRecord(raw.event) ? raw.event : raw) : null;
    if (!ev) continue;
    const nodeId = asString(ev.nodeId);
    const type = asString(ev.type);
    if (!nodeId || !type) continue;
    if (typeof ev.iteration === "number") {
      iteration.set(nodeId, Math.max(iteration.get(nodeId) ?? 0, ev.iteration));
    }
    if (type === "NodeFinished") status.set(nodeId, "done");
    else if (type === "NodeFailed" || type === "NodeCancelled") status.set(nodeId, "failed");
    else if (type === "NodeSkipped") status.set(nodeId, "skipped");
    else if (type === "NodeWaitingApproval") status.set(nodeId, "waiting");
    else if (type === "NodeStarted" || type === "NodeRetrying" || type === "TaskHeartbeat") {
      status.set(nodeId, "running");
    }
  }
  return { status, iteration };
}

const DOT: Record<NodeStatus, string> = {
  pending: "#3a3a40",
  running: "#60a5fa",
  done: "#4ade80",
  failed: "#f87171",
  waiting: "#fbbf24",
  skipped: "#8a8a8e",
};

function Chip({ label, state }: { label: string; state: NodeStatus }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        padding: "3px 8px",
        borderRadius: 6,
        border: "1px solid #262629",
        background: state === "running" ? "#12233c" : "#151518",
        color: state === "pending" ? "#8a8a8e" : "#eee",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 99, background: DOT[state], display: "inline-block" }} />
      {label}
    </span>
  );
}

function SummaryCard({ title, runId, nodeId }: { title: string; runId?: string; nodeId: string }) {
  const out = useGatewayNodeOutput({ runId, nodeId });
  const row = unwrapRow(out.data);
  if (!row) return null;
  const summary = asString(row.summary) ?? asString(row.verdict) ?? "";
  const ok = row.approved === true || row.pushed === true || row.committed === true;
  return (
    <div style={{ border: "1px solid #262629", borderRadius: 8, padding: "10px 14px", background: "#151518" }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
        {title} <span style={{ color: ok ? "#4ade80" : "#fbbf24" }}>{ok ? "✔" : "…"}</span>
      </div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11, color: "#b6b6ba", fontFamily: "ui-monospace,monospace" }}>
        {summary.slice(0, 1200)}
      </pre>
    </div>
  );
}

function App() {
  const runId = runIdFromUrl();
  const run = useGatewayRun(runId);
  const { events } = useGatewayRunEvents(runId, { maxEvents: 4000 });
  const { cancelRun } = useGatewayActions();
  const { status, iteration } = useMemo(() => buildNodeState(events as unknown[]), [events]);
  const st = (nodeId: string): NodeStatus => status.get(nodeId) ?? "pending";
  const runStatus = asString(run.data?.status) ?? "…";

  const doneItems = ITEMS.filter((i) => st(`${i.key}:review`) === "done").length;

  return (
    <div style={{ minHeight: "100vh", background: "#0c0c0e", color: "#eee", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid #262629", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 14 }}>⚡ Issue Blitz</h1>
        <span style={{ fontSize: 11, color: "#8a8a8e", fontFamily: "ui-monospace,monospace" }}>{runId?.slice(0, 8) ?? "--"}</span>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", padding: "3px 8px", borderRadius: 5, border: "1px solid #262629", color: runStatus === "failed" ? "#f87171" : runStatus === "finished" ? "#4ade80" : "#60a5fa" }}>
          {runStatus}
        </span>
        <span style={{ color: "#8a8a8e", fontSize: 12 }}>
          {doneItems}/{ITEMS.length} items through review · sol plans → terra/luna implement → luna LGTM → sol commits → fable gate → push
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => runId && cancelRun({ runId })}
          style={{ height: 28, padding: "0 12px", border: "1px solid #262629", borderRadius: 6, background: "#151518", color: "#f87171", cursor: "pointer" }}
        >
          Cancel run
        </button>
      </div>

      <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Chip label="discover" state={st("discover")} />
          <span style={{ color: "#3a3a40" }}>→</span>
          <Chip label={`plan ×${ITEMS.length} (sol)`} state={ITEMS.every((i) => st(`${i.key}:plan`) === "done") ? "done" : ITEMS.some((i) => st(`${i.key}:plan`) === "running") ? "running" : "pending"} />
          <span style={{ color: "#3a3a40" }}>→</span>
          <Chip label="implement + review" state={doneItems === ITEMS.length ? "done" : ITEMS.some((i) => st(`${i.key}:implement`) === "running" || st(`${i.key}:review`) === "running") ? "running" : "pending"} />
          <span style={{ color: "#3a3a40" }}>→</span>
          <Chip label="commit (sol)" state={st("commit-all")} />
          <span style={{ color: "#3a3a40" }}>→</span>
          <Chip label="review (fable)" state={st("fable-review")} />
          <span style={{ color: "#3a3a40" }}>→</span>
          <Chip label="rebase + push" state={st("push")} />
        </div>

        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#8a8a8e", fontSize: 11, textTransform: "uppercase" }}>
              <th style={{ padding: "6px 8px" }}>Item</th>
              <th style={{ padding: "6px 8px" }}>Issues</th>
              <th style={{ padding: "6px 8px" }}>Implementer</th>
              <th style={{ padding: "6px 8px" }}>Plan</th>
              <th style={{ padding: "6px 8px" }}>Implement</th>
              <th style={{ padding: "6px 8px" }}>Luna review</th>
              <th style={{ padding: "6px 8px" }}>Iter</th>
            </tr>
          </thead>
          <tbody>
            {ITEMS.map((item) => (
              <tr key={item.key} style={{ borderTop: "1px solid #262629" }}>
                <td style={{ padding: "8px" }}>
                  <div style={{ fontWeight: 600 }}>{item.key}</div>
                  <div style={{ color: "#8a8a8e", fontSize: 11 }}>{item.title}</div>
                </td>
                <td style={{ padding: "8px", fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#8a8a8e" }}>
                  {item.issues.map((n) => `#${n}`).join(" ")}
                </td>
                <td style={{ padding: "8px" }}>
                  <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, border: "1px solid #262629", color: item.kind === "hard" ? "#fbbf24" : "#60a5fa" }}>
                    {item.kind === "hard" ? "terra" : "luna"}
                  </span>
                </td>
                <td style={{ padding: "8px" }}><Chip label="plan" state={st(`${item.key}:plan`)} /></td>
                <td style={{ padding: "8px" }}><Chip label="impl" state={st(`${item.key}:implement`)} /></td>
                <td style={{ padding: "8px" }}><Chip label="review" state={st(`${item.key}:review`)} /></td>
                <td style={{ padding: "8px", fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#8a8a8e" }}>
                  {(iteration.get(`${item.key}:implement`) ?? 0) + 1}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <SummaryCard title="Sol commits" runId={runId} nodeId="commit-all" />
        <SummaryCard title="Fable final review" runId={runId} nodeId="fable-review" />
        <SummaryCard title="Rebase + push" runId={runId} nodeId="push" />
      </div>
    </div>
  );
}

createGatewayReactRoot(<App />);
