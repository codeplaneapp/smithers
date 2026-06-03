/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "ship-tickets";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

// ── value coercion (mirrors the other workflow UIs) ────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asStringArray(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function slugFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("ticket") ?? undefined;
}
// Node output hooks deliver { status, row, schema }; unwrap the row.
function rowOf(value: unknown): Record<string, unknown> {
  const data = isRecord(value) ? value : {};
  return isRecord(data.row) ? data.row : data;
}

// ── per-node extractors ────────────────────────────────────────────────────
type TicketRef = { slug: string; title: string; id: string };
function extractManifest(value: unknown): TicketRef[] {
  const row = rowOf(value);
  return asArray(row.tickets)
    .filter(isRecord)
    .map((t) => ({
      slug: asString(t.slug) ?? "",
      title: asString(t.title) ?? asString(t.slug) ?? "ticket",
      id: asString(t.id) ?? "",
    }))
    .filter((t) => t.slug.length > 0);
}

type ResearchOutput = { summary: string; keyFindings: string[] };
function extractResearch(value: unknown): ResearchOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, keyFindings: asStringArray(row.keyFindings) };
}

type PlanOutput = { summary: string; steps: string[] };
function extractPlan(value: unknown): PlanOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return { summary, steps: asStringArray(row.steps) };
}

type ImplementOutput = { summary: string; filesChanged: string[]; allTestsPassing: boolean };
function extractImplement(value: unknown): ImplementOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    summary,
    filesChanged: asStringArray(row.filesChanged),
    allTestsPassing: asBool(row.allTestsPassing) ?? true,
  };
}

type ValidateOutput = { summary: string; allPassed: boolean; failingSummary: string | null };
function extractValidate(value: unknown): ValidateOutput | null {
  const row = rowOf(value);
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    summary,
    allPassed: asBool(row.allPassed) ?? true,
    failingSummary: asString(row.failingSummary) ?? null,
  };
}

type ReviewOutput = { reviewer: string; approved: boolean; feedback: string };
function extractReview(value: unknown): ReviewOutput | null {
  const row = rowOf(value);
  const reviewer = asString(row.reviewer);
  const approved = asBool(row.approved);
  if (reviewer === undefined && approved === undefined) return null;
  return {
    reviewer: reviewer ?? "reviewer",
    approved: approved ?? false,
    feedback: asString(row.feedback) ?? "",
  };
}

type ShipResult = { branch: string; status: string; summary: string };
function extractShip(value: unknown): ShipResult | null {
  const row = rowOf(value);
  const status = asString(row.status);
  if (status === undefined) return null;
  return {
    branch: asString(row.branch) ?? "",
    status,
    summary: asString(row.summary) ?? "",
  };
}

// ── pipeline stage model ───────────────────────────────────────────────────
type StageState = "pending" | "active" | "done" | "failed";
const STAGES: Array<{ key: string; label: string; abbr: string; node: (slug: string) => string }> = [
  { key: "research", label: "Research", abbr: "R", node: (s) => `${s}:research` },
  { key: "plan", label: "Plan", abbr: "P", node: (s) => `${s}:plan` },
  { key: "implement", label: "Implement", abbr: "I", node: (s) => `${s}:implement` },
  { key: "validate", label: "Validate", abbr: "V", node: (s) => `${s}:validate` },
  { key: "review", label: "Review", abbr: "Rv", node: (s) => `${s}:review:0` },
  { key: "merge", label: "Merge", abbr: "M", node: (s) => `${s}:merge` },
];

function classifyType(type: string): StageState | "" {
  if (type.includes("fail") || type.includes("error") || type.includes("cancel")) return "failed";
  if (type.includes("complete") || type.includes("finish")) return "done";
  if (type.includes("start")) return "active";
  return "";
}

// The run-event stream wraps each node lifecycle event two levels deep:
//   { event: "run.event",
//     payload: { streamId, event: "node.finished", payload: { nodeId, state }, seq } }
// so the classifiable label is `payload.event` (node.started/finished/failed) and
// the nodeId is `payload.payload.nodeId`. We also accept shallower shapes so the
// UI degrades gracefully if the frame envelope ever changes.
type EventInfo = { nodeId: string; type: string; seq: number };
function eventInfo(ev: unknown): EventInfo {
  const frame = isRecord(ev) ? ev : {};
  const inner = isRecord(frame.payload) ? frame.payload : {};
  const nodePayload = isRecord(inner.payload) ? inner.payload : {};
  const nodeId = asString(nodePayload.nodeId) ?? asString(inner.nodeId) ?? asString(frame.nodeId) ?? "";
  const type = asString(inner.event) ?? asString(frame.type) ?? asString(nodePayload.state) ?? "";
  const seq = typeof inner.seq === "number" ? inner.seq : typeof frame.seq === "number" ? frame.seq : 0;
  return { nodeId, type, seq };
}

/** Latest-wins status per nodeId, derived from the ordered event stream. */
function buildNodeStatus(events: unknown[]): Record<string, StageState> {
  const map: Record<string, StageState> = {};
  for (const ev of events) {
    const { nodeId, type } = eventInfo(ev);
    if (!nodeId) continue;
    const cls = classifyType(type);
    if (cls) map[nodeId] = cls;
  }
  return map;
}

type TicketProgress = {
  stages: Array<{ key: string; label: string; abbr: string; state: StageState }>;
  overall: "queued" | "running" | "failed" | "landed";
  caption: string;
};
function ticketProgress(slug: string, nodeStatus: Record<string, StageState>): TicketProgress {
  const stages = STAGES.map((st) => ({
    key: st.key,
    label: st.label,
    abbr: st.abbr,
    state: nodeStatus[st.node(slug)] ?? "pending",
  }));
  const mergeState = stages[stages.length - 1].state;
  if (mergeState === "done") return { stages, overall: "landed", caption: "landed on main" };
  const failed = stages.find((s) => s.state === "failed");
  if (failed) return { stages, overall: "failed", caption: `${failed.label} failed` };
  const active = stages.find((s) => s.state === "active");
  if (active) return { stages, overall: "running", caption: active.label.toLowerCase() };
  const lastDone = [...stages].reverse().find((s) => s.state === "done");
  if (lastDone) return { stages, overall: "running", caption: `${lastDone.label.toLowerCase()} done` };
  return { stages, overall: "queued", caption: "queued" };
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input,textarea { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".progress-pill { color:var(--text); }",
  ".progress-pill b { color:var(--ok); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; flex-wrap:wrap; }",
  ".prompt { height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".prompt.dir { min-width:220px; }",
  ".check { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); cursor:pointer; user-select:none; }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished, .badge.landed, .badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed, .badge.err { color:var(--err); border-color:var(--err); }",
  ".badge.queued { color:var(--muted); }",
  ".main { display:grid; grid-template-columns:minmax(300px,1.1fr) minmax(0,1.3fr) 260px; flex:1; overflow:hidden; }",
  "@media (max-width:1040px){ .main { grid-template-columns:1fr; overflow:auto; } .col.mid,.sidebar { border-left:0; border-top:1px solid var(--border); } }",
  ".col { padding:18px 20px; overflow:auto; }",
  ".col.mid { border-left:1px solid var(--border); }",
  ".section-head { margin:0 0 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".pipeline { list-style:none; margin:0; padding:0; }",
  ".ticket { width:100%; text-align:left; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:10px; cursor:pointer; color:var(--text); display:block; }",
  ".ticket:hover { border-color:#33333a; }",
  ".ticket.active { box-shadow:inset 3px 0 0 var(--primary); border-color:#33333a; }",
  ".ticket-top { display:flex; align-items:center; gap:8px; justify-content:space-between; }",
  ".ticket-title { font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".ticket-num { flex:0 0 auto; font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); margin-right:2px; }",
  ".ticket-caption { font-size:11px; color:var(--muted); margin-top:3px; }",
  ".strip { display:flex; gap:4px; margin-top:10px; }",
  ".seg { flex:1; height:22px; border-radius:5px; border:1px solid var(--border); background:var(--panel); display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; color:var(--muted); }",
  ".seg.done { background:rgba(74,222,128,0.16); border-color:var(--ok); color:var(--ok); }",
  ".seg.active { background:rgba(251,191,36,0.16); border-color:var(--warn); color:var(--warn); }",
  ".seg.failed { background:rgba(248,113,113,0.16); border-color:var(--err); color:var(--err); }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:12px; overflow:hidden; }",
  ".panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 15px; cursor:pointer; }",
  ".panel-head h2 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".panel-head .left { display:flex; align-items:center; gap:8px; min-width:0; }",
  ".panel-body { padding:0 15px 14px; }",
  ".summary-text { font-size:13px; line-height:1.55; }",
  ".findings, .steps, .files { list-style:none; margin:8px 0 0; padding:0; }",
  ".findings li { display:flex; gap:8px; padding:5px 0; border-bottom:1px solid var(--border); }",
  ".findings li:last-child, .steps li:last-child, .files li:last-child { border-bottom:0; }",
  ".dot { flex:0 0 6px; height:6px; margin-top:7px; border-radius:50%; background:var(--primary); }",
  ".steps li { display:flex; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); }",
  ".step-num { flex:0 0 22px; height:22px; border-radius:50%; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".files li { font-family:ui-monospace,monospace; font-size:12px; padding:4px 0; border-bottom:1px solid var(--border); }",
  ".muted { color:var(--muted); }",
  ".ticket-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }",
  ".ticket-head h2 { margin:0; font-size:15px; }",
  ".ticket-head .mono { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); }",
  ".activity { list-style:none; margin:6px 0 0; padding:0; max-height:200px; overflow:auto; }",
  ".activity li { display:flex; gap:8px; align-items:baseline; padding:4px 0; border-bottom:1px solid var(--border); font-size:12px; }",
  ".activity .stage { font-family:ui-monospace,monospace; color:var(--muted); flex:0 0 84px; }",
  ".activity .ev.done { color:var(--ok); }",
  ".activity .ev.active { color:var(--warn); }",
  ".activity .ev.failed { color:var(--err); }",
  ".ledger { list-style:none; margin:0; padding:0; }",
  ".ledger-row { display:flex; gap:10px; padding:10px 0; border-bottom:1px solid var(--border); align-items:flex-start; }",
  ".ledger-row:last-child { border-bottom:0; }",
  ".ledger-dot { flex:0 0 18px; height:18px; border-radius:50%; background:rgba(74,222,128,0.16); border:1px solid var(--ok); color:var(--ok); display:flex; align-items:center; justify-content:center; font-size:10px; }",
  ".ledger-body { min-width:0; }",
  ".ledger-title { font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
  ".ledger-branch { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); }",
  ".empty { color:var(--muted); text-align:center; padding:40px 16px; }",
  ".launch-form { max-width:520px; margin:24px auto; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; }",
  ".launch-form h2 { margin:0 0 4px; font-size:16px; }",
  ".launch-form p { margin:0 0 18px; color:var(--muted); }",
  ".launch-form .prompt { width:100%; height:34px; margin-bottom:12px; }",
  ".field { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".side-body { padding:12px 16px; }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function Panel(props: { title: string; testId: string; badge?: { text: string; cls: string } | null; pending: boolean; pendingText: string; children?: any }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel" data-testid={props.testId}>
      <div className="panel-head" onClick={() => setOpen((o) => !o)}>
        <div className="left">
          <h2>{props.title}</h2>
          {props.badge ? <span className={"badge " + props.badge.cls}>{props.badge.text}</span> : null}
        </div>
        <span className="muted">{open ? "collapse" : "expand"}</span>
      </div>
      {open ? <div className="panel-body">{props.pending ? <div className="muted">{props.pendingText}</div> : props.children}</div> : null}
    </div>
  );
}

function stageLabelFromNode(nodeId: string, slug: string): string {
  const suffix = nodeId.startsWith(slug + ":") ? nodeId.slice(slug.length + 1) : nodeId;
  return suffix.split(":")[0];
}

// Detail for the selected ticket — calls per-node hooks (a child component so the
// hook count stays constant regardless of how many tickets exist).
function TicketDetail(props: { runId: string | undefined; ticket: TicketRef; events: unknown[] }) {
  const { runId, ticket, events } = props;
  const slug = ticket.slug;

  const researchOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:research`, iteration: 0 });
  const planOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:plan`, iteration: 0 });
  const implementOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:implement`, iteration: 0 });
  const validateOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:validate`, iteration: 0 });
  const reviewOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:review:0`, iteration: 0 });
  const mergeOut = useGatewayNodeOutput({ runId, nodeId: `${slug}:merge`, iteration: 0 });

  const research = useMemo(() => extractResearch(researchOut.data), [researchOut.data]);
  const plan = useMemo(() => extractPlan(planOut.data), [planOut.data]);
  const implement = useMemo(() => extractImplement(implementOut.data), [implementOut.data]);
  const validate = useMemo(() => extractValidate(validateOut.data), [validateOut.data]);
  const review = useMemo(() => extractReview(reviewOut.data), [reviewOut.data]);
  const ship = useMemo(() => extractShip(mergeOut.data), [mergeOut.data]);

  const activity = useMemo(() => {
    return events
      .map(eventInfo)
      .filter((e) => e.nodeId.startsWith(slug + ":"))
      .slice(-14)
      .reverse()
      .map((e) => ({ seq: e.seq, stage: stageLabelFromNode(e.nodeId, slug), type: e.type }));
  }, [events, slug]);

  return (
    <>
      <div className="ticket-head">
        <h2>{ticket.title}</h2>
        <span className="mono">ship/{slug}</span>
        {ship ? <span className={"badge " + (ship.status === "merged" ? "landed" : ship.status === "failed" ? "failed" : "queued")}>{ship.status}</span> : null}
      </div>

      <Panel title="Research" testId="st-research" badge={research ? { text: "ready", cls: "ok" } : null} pending={research === null} pendingText="Gathering context…">
        {research ? (
          <>
            <div className="summary-text">{research.summary}</div>
            {research.keyFindings.length > 0 ? (
              <ul className="findings">{research.keyFindings.map((f, i) => <li key={i}><span className="dot" /><span>{f}</span></li>)}</ul>
            ) : null}
          </>
        ) : null}
      </Panel>

      <Panel title="Plan" testId="st-plan" badge={plan ? { text: "ready", cls: "ok" } : null} pending={plan === null} pendingText="Creating plan…">
        {plan ? (
          <>
            <div className="summary-text">{plan.summary}</div>
            {plan.steps.length > 0 ? (
              <ol className="steps">{plan.steps.map((s, i) => <li key={i}><span className="step-num">{i + 1}</span><span>{s}</span></li>)}</ol>
            ) : null}
          </>
        ) : null}
      </Panel>

      <Panel
        title="Implement"
        testId="st-implement"
        badge={implement ? (implement.allTestsPassing ? { text: "tests pass", cls: "ok" } : { text: "tests fail", cls: "err" }) : null}
        pending={implement === null}
        pendingText="Implementing…"
      >
        {implement ? (
          <>
            <div className="summary-text">{implement.summary}</div>
            {implement.filesChanged.length > 0 ? (
              <ul className="files">{implement.filesChanged.map((f, i) => <li key={i}>{f}</li>)}</ul>
            ) : <div className="muted">No files changed yet.</div>}
          </>
        ) : null}
      </Panel>

      <Panel
        title="Validate"
        testId="st-validate"
        badge={validate ? (validate.allPassed ? { text: "passed", cls: "ok" } : { text: "failed", cls: "err" }) : null}
        pending={validate === null}
        pendingText="Validating…"
      >
        {validate ? (
          <>
            <div className="summary-text">{validate.summary}</div>
            {validate.failingSummary ? <div className="muted" style={{ marginTop: 6 }}>{validate.failingSummary}</div> : null}
          </>
        ) : null}
      </Panel>

      <Panel
        title="Review"
        testId="st-review"
        badge={review ? (review.approved ? { text: "approved", cls: "ok" } : { text: "rejected", cls: "err" }) : null}
        pending={review === null}
        pendingText="Awaiting reviewer…"
      >
        {review ? (
          <>
            <strong>{review.reviewer}</strong>
            {review.feedback ? <div className="muted" style={{ marginTop: 6 }}>{review.feedback}</div> : null}
          </>
        ) : null}
      </Panel>

      <Panel
        title="Commit → Merge to main"
        testId="st-merge"
        badge={ship ? (ship.status === "merged" ? { text: "landed", cls: "landed" } : ship.status === "failed" ? { text: "failed", cls: "err" } : { text: ship.status, cls: "queued" }) : null}
        pending={ship === null}
        pendingText="Awaiting implementation to finish…"
      >
        {ship ? (
          <>
            {ship.branch ? <div className="mono muted" style={{ marginBottom: 6 }}>{ship.branch} → main</div> : null}
            <div className="summary-text">{ship.summary}</div>
          </>
        ) : null}
      </Panel>

      <p className="section-head" style={{ marginTop: 16 }}>Live activity</p>
      {activity.length > 0 ? (
        <ul className="activity" data-testid="ticket-activity">
          {activity.map((a) => (
            <li key={a.seq}>
              <span className="stage">{a.stage}</span>
              <span className={"ev " + (classifyType(a.type) || "")}>{a.type || "event"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted">No activity for this ticket yet.</div>
      )}
    </>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>(slugFromUrl());
  const [ticketsDir, setTicketsDir] = useState(".smithers/tickets/ultragrill");
  const [baseBranch, setBaseBranch] = useState("main");
  const [tdd, setTdd] = useState(false);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);

  const runDetail = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const manifestOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "manifest", iteration: 0 });

  const tickets = useMemo(() => extractManifest(manifestOut.data), [manifestOut.data]);
  const events = stream.events ?? [];
  const nodeStatus = useMemo(() => buildNodeStatus(events), [events]);

  const progressByTicket = useMemo(() => {
    const map: Record<string, TicketProgress> = {};
    for (const t of tickets) map[t.slug] = ticketProgress(t.slug, nodeStatus);
    return map;
  }, [tickets, nodeStatus]);

  const landed = tickets.filter((t) => progressByTicket[t.slug]?.overall === "landed");
  const frontier = tickets.find((t) => progressByTicket[t.slug]?.overall !== "landed");
  const activeSlug = selectedSlug ?? frontier?.slug ?? tickets[0]?.slug;
  const selectedTicket = tickets.find((t) => t.slug === activeSlug);

  const runStatus = (runDetail.data as RunSummary | undefined)?.status ?? activeRun?.status;
  const eventCount = events.length;
  const hasRun = Boolean(activeRunId);

  function selectSlug(slug: string) {
    setSelectedSlug(slug);
    if (typeof history !== "undefined" && activeRunId) {
      const params = new URLSearchParams(location.search);
      params.set("runId", activeRunId);
      params.set("ticket", slug);
      history.replaceState(null, "", "?" + params.toString());
    }
  }

  async function refresh() {
    await Promise.all([runsQuery.refetch(), runDetail.refetch(), manifestOut.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { ticketsDir, baseBranch, tdd } });
      setSelectedRunId(run.runId);
      setSelectedSlug(undefined);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="ship-tickets-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Ship Tickets</h1>
          <span className="pill" data-testid="ship-runid"><span className="mono">{hasRun ? shortRunId(activeRunId) : "No run"}</span></span>
          {hasRun ? <span className={"badge " + statusClass(runStatus)} data-testid="ship-status">{runStatus ?? "idle"}</span> : null}
          {hasRun && tickets.length > 0 ? (
            <span className="pill progress-pill" data-testid="ship-progress"><b>{landed.length}</b>/{tickets.length} landed</span>
          ) : null}
          {hasRun ? <span className="pill">{eventCount} events</span> : null}
        </div>
        <div className="toolbar">
          <button className="button" data-testid="ship-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {statusClass(runStatus) === "running" ? (
            <button className="button danger" data-testid="ship-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="ship-launch" onClick={() => void launch()} disabled={busy}>Launch</button>
        </div>
      </header>

      <div className="main">
        {/* ── pipeline ──────────────────────────────────────────────── */}
        <div className="col left">
          {!hasRun ? (
            <div className="launch-form" data-testid="ship-empty">
              <h2>Ship a ticket queue</h2>
              <p>Each ticket runs research → plan → implement → validate → review in its own worktree, then commits and merges to the base branch — serially, so the branch advances one ticket at a time.</p>
              <input className="prompt dir" value={ticketsDir} onChange={(e) => setTicketsDir(e.currentTarget.value)} placeholder="Tickets directory" data-testid="ship-ticketsdir" />
              <div className="field"><label>Base branch</label><input className="prompt" style={{ width: 160 }} value={baseBranch} onChange={(e) => setBaseBranch(e.currentTarget.value)} /></div>
              <div className="field"><label>Test-driven (tests first)</label><input type="checkbox" checked={tdd} onChange={(e) => setTdd(e.currentTarget.checked)} /></div>
              <button className="button primary" data-testid="ship-launch-empty" onClick={() => void launch()} disabled={busy} style={{ marginTop: 14 }}>Launch Ship</button>
            </div>
          ) : (
            <>
              <p className="section-head">Pipeline <span>{tickets.length} tickets</span></p>
              {tickets.length === 0 ? (
                <div className="muted">Waiting for the ticket manifest…</div>
              ) : (
                <ul className="pipeline" data-testid="ship-pipeline">
                  {tickets.map((t, i) => {
                    const prog = progressByTicket[t.slug];
                    return (
                      <li key={t.slug}>
                        <button className={"ticket" + (t.slug === activeSlug ? " active" : "")} data-testid={"ship-ticket-" + t.slug} onClick={() => selectSlug(t.slug)}>
                          <div className="ticket-top">
                            <span className="ticket-title"><span className="ticket-num">{String(i + 1).padStart(2, "0")}</span>{t.title}</span>
                            <span className={"badge " + (prog?.overall ?? "queued")}>{prog?.overall ?? "queued"}</span>
                          </div>
                          <div className="ticket-caption">{prog?.caption}</div>
                          <div className="strip">
                            {(prog?.stages ?? STAGES.map((s) => ({ ...s, state: "pending" as StageState }))).map((s) => (
                              <span key={s.key} className={"seg " + (s.state === "pending" ? "" : s.state)} title={s.label + " · " + s.state}>{s.abbr}</span>
                            ))}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>

        {/* ── selected ticket detail ────────────────────────────────── */}
        <div className="col mid">
          {hasRun && selectedTicket ? (
            <TicketDetail runId={activeRunId} ticket={selectedTicket} events={events} />
          ) : (
            <div className="empty" data-testid="ship-detail-empty">{hasRun ? "Select a ticket to watch its research → merge detail." : "Launch a run to watch tickets ship."}</div>
          )}
        </div>

        {/* ── landed-on-main ledger + runs ──────────────────────────── */}
        <aside className="sidebar">
          <div className="side-head">Landed on {baseBranch}</div>
          <div className="side-body">
            {landed.length > 0 ? (
              <ul className="ledger" data-testid="ship-ledger">
                {landed.map((t) => (
                  <li className="ledger-row" key={t.slug} onClick={() => selectSlug(t.slug)} style={{ cursor: "pointer" }}>
                    <span className="ledger-dot">✓</span>
                    <span className="ledger-body">
                      <span className="ledger-title">{t.title}</span>
                      <span className="ledger-branch">ship/{t.slug}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="muted">No commits on {baseBranch} yet.</div>
            )}
          </div>
          <div className="side-head">Recent runs</div>
          {runs.map((r) => (
            <button key={r.runId} className={"run-row" + (r.runId === activeRunId ? " active" : "")} data-testid={"ship-run-" + r.runId} onClick={() => { setSelectedRunId(r.runId); setSelectedSlug(undefined); }}>
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {runs.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
