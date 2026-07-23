/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import {
  ConnectionBadge,
  RunEventLog,
  RunTree,
  StatusPill,
  WorkflowUiShell,
  theme,
} from "smithers-orchestrator/gateway-ui";

const WORKFLOW = "vibe-audit";

const STRATEGIES = [
  { nodeId: "injection-scan", label: "Injection scan" },
  { nodeId: "auth-review", label: "Auth review" },
  { nodeId: "secrets-scan", label: "Secrets scan" },
  { nodeId: "deps-audit", label: "Dependency audit" },
] as const;

const PIPELINE = [
  { nodeId: "dedupe", label: "Dedupe" },
  { nodeId: "triage", label: "Triage" },
  { nodeId: "report", label: "Report" },
] as const;

type NodeLite = { id: string; status: string; error?: string };
type Finding = { findingKey?: string; title?: string; file?: string; severity?: string };

function rowOf(state: { data?: Record<string, unknown> }): Record<string, unknown> | undefined {
  const d = state?.data;
  if (d && typeof d === "object" && "row" in d) return (d as { row?: Record<string, unknown> }).row;
  return d;
}

const SEV_COLOR: Record<string, string> = { high: "#e5484d", medium: "#f5a623", low: "#3aa675" };

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, color: "#fff", background: color, whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

function nodeStatus(nodes: readonly NodeLite[], id: string): NodeLite | undefined {
  return nodes.find((n) => n.id === id);
}

/** One audit strategy card: status, agent, finding count, and the parked-on-quota
 *  -> fallback-agent story when the node's first attempt rate-limits. */
function StrategyCard({ runId, nodeId, label, node, sig, rateLimited }: { runId: string; nodeId: string; label: string; node: NodeLite | undefined; sig: string; rateLimited: boolean }) {
  const output = useGatewayNodeOutput({ runId, nodeId });
  useEffect(() => {
    void output.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const row = rowOf(output) as { agentUsed?: string; findingCount?: number } | undefined;
  const status = node?.status ?? "queued";
  const parked = rateLimited && status !== "finished";
  const recovered = rateLimited && status === "finished";

  return (
    <div
      style={{
        border: `1px solid ${parked ? "#f5a623" : status === "running" ? (theme.accent ?? "#5b8def") : (theme.border ?? "#2a2d34")}`,
        borderRadius: 10,
        padding: 14,
        background: theme.panel ?? "#16181d",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: theme.text ?? "#e6e6e6" }}>{label}</span>
        <StatusPill status={parked ? "waiting" : status} />
      </div>
      {parked ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <Badge text="rate-limited · parked on quota" color="#f5a623" />
          <span style={{ fontSize: 11, color: theme.textDim ?? "#8a8f98" }}>anthropic 429 — retrying on fallback agent…</span>
        </div>
      ) : null}
      {recovered ? <Badge text="recovered on fallback agent" color="#3aa675" /> : null}
      <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>
        <span>{row?.agentUsed ? `agent: ${row.agentUsed}` : status === "running" ? "scanning…" : parked ? "waiting for retry" : "queued"}</span>
        {typeof row?.findingCount === "number" ? (
          <span style={{ color: theme.text ?? "#e6e6e6", fontWeight: 600 }}>{row.findingCount} findings</span>
        ) : null}
      </div>
    </div>
  );
}

function PipelineCard({ runId, nodeId, label, node, sig }: { runId: string; nodeId: string; label: string; node: NodeLite | undefined; sig: string }) {
  const output = useGatewayNodeOutput({ runId, nodeId });
  useEffect(() => {
    void output.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const row = rowOf(output) as { uniqueCount?: number; duplicateCount?: number; highCount?: number; mediumCount?: number; lowCount?: number; totalFindings?: number } | undefined;
  const status = node?.status ?? "queued";
  const detail =
    nodeId === "dedupe" && row
      ? `${row.uniqueCount} unique · ${row.duplicateCount} duplicates dropped`
      : nodeId === "triage" && row
        ? `${row.highCount} high · ${row.mediumCount} medium · ${row.lowCount} low`
        : nodeId === "report" && row
          ? `${row.totalFindings} findings aggregated`
          : status === "running"
            ? "working…"
            : "waiting on strategies";

  return (
    <div style={{ border: `1px solid ${status === "running" ? (theme.accent ?? "#5b8def") : (theme.border ?? "#2a2d34")}`, borderRadius: 10, padding: "10px 14px", background: theme.panel ?? "#16181d", display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: theme.text ?? "#e6e6e6", minWidth: 64 }}>{label}</span>
      <StatusPill status={status} />
      <span style={{ fontSize: 12, color: theme.textDim ?? "#8a8f98", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{detail}</span>
    </div>
  );
}

function FindingsTable({ runId, sig, done }: { runId: string; sig: string; done: boolean }) {
  const triage = useGatewayNodeOutput({ runId, nodeId: "triage" });
  useEffect(() => {
    void triage.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const row = rowOf(triage) as { triagedJson?: string } | undefined;
  const findings: Finding[] = useMemo(() => {
    try {
      return row?.triagedJson ? (JSON.parse(row.triagedJson) as Finding[]) : [];
    } catch {
      return [];
    }
  }, [row?.triagedJson]);

  if (findings.length === 0) {
    return (
      <div style={{ padding: 18, textAlign: "center", fontSize: 12, color: theme.textDim ?? "#8a8f98" }}>
        {done ? "No findings." : "Findings land here as strategies report…"}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {findings.map((f) => (
        <div key={f.findingKey} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", borderTop: `1px solid ${theme.border ?? "#2a2d34"}` }}>
          <Badge text={(f.severity ?? "info").toUpperCase()} color={SEV_COLOR[f.severity ?? ""] ?? "#8a8f98"} />
          <span style={{ fontSize: 13, color: theme.text ?? "#e6e6e6", flex: 1, minWidth: 0 }}>{f.title}</span>
          <code style={{ fontSize: 11, color: theme.textDim ?? "#8a8f98" }}>{f.file}</code>
        </div>
      ))}
    </div>
  );
}

function App() {
  const runsRaw = useGatewayRuns({ filter: { workflow: WORKFLOW, limit: 10 } });
  const runs = (runsRaw.data ?? []) as Array<{ runId: string; status?: string }>;
  const urlRunId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("runId") ?? undefined : undefined;
  const runId = urlRunId ?? runs[0]?.runId;

  const { nodes, status } = useGatewayRunTree(runId);
  const nodesLite = nodes as unknown as NodeLite[];
  const sig = nodesLite.map((n) => `${n.id}:${n.status}`).join(",");

  // Rate-limited nodes derived from the durable event log (frames wrap the
  // lifecycle event at payload.event / payload.payload.nodeId), so a brief
  // failed->retrying window can never be missed between tree polls.
  const stream = useGatewayRunEvents(runId, { afterSeq: 0 });
  const rateLimitedNodes = useMemo(() => {
    const hit = new Set<string>();
    for (const frame of (stream.events ?? []) as Array<Record<string, unknown>>) {
      const payload = (frame as { payload?: { event?: string; payload?: { nodeId?: string } } }).payload;
      const kind = String(payload?.event ?? "");
      if (!/failed|retry/i.test(kind)) continue;
      if (!/rate.?limit|429|quota/i.test(JSON.stringify(frame))) continue;
      const nodeId = payload?.payload?.nodeId;
      if (typeof nodeId === "string") hit.add(nodeId);
    }
    return hit;
  }, [stream.events]);
  const done = status === "finished";
  const repo = "smithersai/payments-api";

  return (
    <WorkflowUiShell
      title="vibe-audit · security review"
      meta={
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="pill">repo: {repo}</span>
          <span className="pill">4 strategies · parallel</span>
        </span>
      }
      actions={
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusPill status={status} />
          <ConnectionBadge className="chip" />
        </span>
      }
    >
      {!runId ? (
        <section className="card">
          <div style={{ padding: 24, textAlign: "center", color: theme.textDim ?? "#8a8f98" }}>
            No <code>vibe-audit</code> run yet.
          </div>
        </section>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          <section style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {STRATEGIES.map((s) => (
                <StrategyCard key={s.nodeId} runId={runId} nodeId={s.nodeId} label={s.label} node={nodeStatus(nodesLite, s.nodeId)} sig={sig} rateLimited={rateLimitedNodes.has(s.nodeId)} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              {PIPELINE.map((p) => (
                <PipelineCard key={p.nodeId} runId={runId} nodeId={p.nodeId} label={p.label} node={nodeStatus(nodesLite, p.nodeId)} sig={sig} />
              ))}
            </div>
            <div style={{ border: `1px solid ${theme.border ?? "#2a2d34"}`, borderRadius: 10, background: theme.panel ?? "#16181d" }}>
              <div style={{ padding: "10px 12px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textDim ?? "#8a8f98" }}>
                Triaged findings
              </div>
              <FindingsTable runId={runId} sig={sig} done={done} />
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12, position: "sticky", top: 12 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textDim ?? "#8a8f98", marginBottom: 6 }}>Run tree</div>
              <RunTree runId={runId} style={{ maxHeight: 360 }} />
            </div>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.textDim ?? "#8a8f98", marginBottom: 6 }}>Live events</div>
              <RunEventLog runId={runId} style={{ maxHeight: 320 }} />
            </div>
          </section>
        </div>
      )}
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
