/** @jsxImportSource react */
import { useEffect, useMemo } from "react";
import {
  createGatewayReactRoot,
  type NodeStatus,
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
  WorkflowUiStyles,
} from "smithers-orchestrator/gateway-ui";

const WORKFLOW = "vibe-audit";

/** The completed tone of a run/node from `useGatewayRunTree`. `NodeStatus` has
 *  no `"finished"` member, so a stale literal silently never matches — typing
 *  the constant makes that a compile error instead. */
const COMPLETED: NodeStatus = "ok";

/** Board layout, injected through `WorkflowUiStyles` (pack UIs render no raw
 *  `<style>` tag and no `style` prop) so the styleguide tokens stay the single
 *  source of truth for color, spacing, and type. */
const VIBE_AUDIT_CSS = `
.va-board { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
.va-main { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.va-side { display: flex; flex-direction: column; gap: var(--sp-3); position: sticky; top: var(--sp-3); }
.va-strategies { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
.va-pipeline { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--sp-2); }
.va-inline { display: flex; align-items: center; gap: var(--sp-2); }
.va-card { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; padding: var(--sp-3); border: 1px solid var(--border-solid); border-radius: var(--r-2); background: var(--panel); }
.va-card.running { border-color: var(--accent); }
.va-card.parked { border-color: var(--warn); }
.va-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.va-card-title { font-size: var(--fs-4); font-weight: 700; color: var(--text); }
.va-card-parked { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); }
.va-card-meta { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-2); color: var(--text-muted); }
.va-card-count { color: var(--text); font-weight: 600; }
.va-note { font-size: var(--fs-1); color: var(--text-muted); }
.va-step { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-solid); border-radius: var(--r-2); background: var(--panel); }
.va-step.running { border-color: var(--accent); }
.va-step-label { min-width: 64px; font-size: var(--fs-3); font-weight: 700; color: var(--text); }
.va-step-detail { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.va-panel { border: 1px solid var(--border-solid); border-radius: var(--r-2); background: var(--panel); }
.va-panel-title { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.va-side-title { margin-bottom: var(--sp-1); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.va-findings { display: flex; flex-direction: column; }
.va-finding { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-solid); }
.va-finding-title { flex: 1; min-width: 0; font-size: var(--fs-3); color: var(--text); }
.va-finding-file { font-size: var(--fs-1); color: var(--text-muted); }
.va-empty { padding: var(--sp-5); text-align: center; font-size: var(--fs-2); color: var(--text-muted); }
.va-badge { padding: 2px 8px; border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; white-space: nowrap; color: var(--inverse-text); background: var(--nit); }
.va-badge.danger { background: var(--bad); }
.va-badge.warning { background: var(--warn); }
.va-badge.success { background: var(--ok); }
.va-tree { max-height: 360px; }
.va-events { max-height: 320px; }
`;

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
type BadgeTone = "danger" | "warning" | "success" | "muted";

function rowOf(state: { data?: Record<string, unknown> }): Record<string, unknown> | undefined {
  const d = state?.data;
  if (d && typeof d === "object" && "row" in d) return (d as { row?: Record<string, unknown> }).row;
  return d;
}

const SEV_TONE: Record<string, BadgeTone> = { high: "danger", medium: "warning", low: "success" };

function Badge({ text, tone }: { text: string; tone: BadgeTone }) {
  return <span className={`va-badge ${tone}`}>{text}</span>;
}

function nodeStatus(nodes: readonly NodeLite[], id: string): NodeLite | undefined {
  return nodes.find((n) => n.id === id);
}

/** The demo's parked-on-quota -> recovered-on-fallback beat for one node: a
 *  rate-limited node is parked until it completes, and completion is
 *  {@link COMPLETED}. */
export function quotaBeat(status: string, rateLimited: boolean): "none" | "parked" | "recovered" {
  if (!rateLimited) return "none";
  return status === COMPLETED ? "recovered" : "parked";
}

/** One audit strategy card: status, agent, finding count, and the parked-on-quota
 *  -> fallback-agent story when the node's first attempt rate-limits. */
export function StrategyCard({ runId, nodeId, label, node, sig, rateLimited }: { runId: string; nodeId: string; label: string; node: NodeLite | undefined; sig: string; rateLimited: boolean }) {
  const output = useGatewayNodeOutput({ runId, nodeId });
  useEffect(() => {
    void output.refetch?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const row = rowOf(output) as { agentUsed?: string; findingCount?: number } | undefined;
  const status = node?.status ?? "queued";
  const beat = quotaBeat(status, rateLimited);
  const parked = beat === "parked";

  return (
    <div className={`va-card ${parked ? "parked" : status === "running" ? "running" : ""}`} data-testid={`va-strategy-${nodeId}`}>
      <div className="va-card-head">
        <span className="va-card-title">{label}</span>
        <StatusPill status={parked ? "waiting" : status} />
      </div>
      {parked ? (
        <div className="va-card-parked">
          <Badge text="rate-limited · parked on quota" tone="warning" />
          <span className="va-note">anthropic 429 — retrying on fallback agent…</span>
        </div>
      ) : null}
      {beat === "recovered" ? <Badge text="recovered on fallback agent" tone="success" /> : null}
      <div className="va-card-meta">
        <span>{row?.agentUsed ? `agent: ${row.agentUsed}` : status === "running" ? "scanning…" : parked ? "waiting for retry" : "queued"}</span>
        {typeof row?.findingCount === "number" ? (
          <span className="va-card-count">{row.findingCount} findings</span>
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
    <div className={`va-step ${status === "running" ? "running" : ""}`}>
      <span className="va-step-label">{label}</span>
      <StatusPill status={status} />
      <span className="va-step-detail">{detail}</span>
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
    return <div className="va-empty">{done ? "No findings." : "Findings land here as strategies report…"}</div>;
  }
  return (
    <div className="va-findings">
      {findings.map((f) => (
        <div key={f.findingKey} className="va-finding">
          <Badge text={(f.severity ?? "info").toUpperCase()} tone={SEV_TONE[f.severity ?? ""] ?? "muted"} />
          <span className="va-finding-title">{f.title}</span>
          <code className="va-finding-file">{f.file}</code>
        </div>
      ))}
    </div>
  );
}

export function VibeAuditApp() {
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
  // Plain per-render scan over event frames. The hook's toFrame yields
  // { type: "event", event: "NodeFailed", payload: { nodeId, ... } } — the
  // event NAME is top-level, the node id one level down in payload.
  const rateLimitedNodes = new Set<string>();
  for (const frame of (stream.events ?? []) as Array<Record<string, unknown>>) {
    const kind = String((frame as { event?: string }).event ?? "");
    if (!/failed|retry/i.test(kind)) continue;
    if (!/rate.?limit|429|quota/i.test(JSON.stringify(frame))) continue;
    const payload = (frame as { payload?: { nodeId?: string; payload?: { nodeId?: string } } }).payload;
    const nodeId = payload?.nodeId ?? payload?.payload?.nodeId;
    if (typeof nodeId === "string") rateLimitedNodes.add(nodeId);
  }
  const done = status === COMPLETED;
  const repo = "smithersai/payments-api";

  return (
    <WorkflowUiShell
      title="vibe-audit · security review"
      meta={
        <span className="va-inline">
          <span className="pill">repo: {repo}</span>
          <span className="pill">4 strategies · parallel</span>
        </span>
      }
      actions={
        <span className="va-inline">
          <StatusPill status={status} />
          <ConnectionBadge className="chip" />
        </span>
      }
    >
      {!runId ? (
        <section className="card">
          <div className="va-empty">
            No <code>vibe-audit</code> run yet.
          </div>
        </section>
      ) : (
        <div className="va-board">
          <section className="va-main">
            <div className="va-strategies">
              {STRATEGIES.map((s) => (
                <StrategyCard key={s.nodeId} runId={runId} nodeId={s.nodeId} label={s.label} node={nodeStatus(nodesLite, s.nodeId)} sig={sig} rateLimited={rateLimitedNodes.has(s.nodeId)} />
              ))}
            </div>
            <div className="va-pipeline">
              {PIPELINE.map((p) => (
                <PipelineCard key={p.nodeId} runId={runId} nodeId={p.nodeId} label={p.label} node={nodeStatus(nodesLite, p.nodeId)} sig={sig} />
              ))}
            </div>
            <div className="va-panel">
              <div className="va-panel-title">Triaged findings</div>
              <FindingsTable runId={runId} sig={sig} done={done} />
            </div>
          </section>

          <section className="va-side">
            <div>
              <div className="va-side-title">Run tree</div>
              <RunTree runId={runId} className="va-tree" />
            </div>
            <div>
              <div className="va-side-title">Live events</div>
              <RunEventLog runId={runId} className="va-events" />
            </div>
          </section>
        </div>
      )}
    </WorkflowUiShell>
  );
}

// Guard the mount so this module can be imported by unit tests (which exercise
// the exported pure helpers and cards); the gateway-served page has #root.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(
    <>
      <WorkflowUiStyles extra={VIBE_AUDIT_CSS} />
      <VibeAuditApp />
    </>,
  );
}
