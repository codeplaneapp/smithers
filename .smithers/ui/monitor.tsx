/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";

const WORKFLOW_KEY = "monitor";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : value == null ? undefined : String(value);
}
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
/** Node-output hooks return either the row directly or `{ row, schema, status }`. */
function rowOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.row)) return value.row;
  return value;
}
/** Read a field by camelCase or snake_case (gateway rows are snake_case). */
function pick(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function runStatusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}
function healthClass(health: string | undefined) {
  if (health === "healthy") return "ok";
  if (health === "blocked" || health === "stuck") return "warn";
  if (health === "failed" || health === "overBudget") return "err";
  return "";
}
function timeAgo(ms: number | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type Question = { nodeId: string; prompt: string; answer: string | null; answeredBy: string | null; pending: boolean };
type ApprovalRow = { nodeId: string; approved: boolean | null; note: string | null; decidedBy: string | null; pending: boolean };
type KeyOutput = { nodeId: string; summary: string; value: string | null };
type DiffRow = { nodeId: string; summary: string; files: string[]; excerpt: string };
type Action = { problem: string; command: string; needsHuman: boolean; selfFixable: boolean };
type Diagnosis = {
  health: string;
  summary: string;
  waitingOn: string | null;
  rootCause: string;
  questions: Question[];
  approvals: ApprovalRow[];
  keyOutputs: KeyOutput[];
  diffs: DiffRow[];
  actions: Action[];
};

function extractDiagnosis(value: unknown): Diagnosis | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    health: asString(row.health) ?? "healthy",
    summary,
    waitingOn: asString(pick(row, "waitingOn", "waiting_on")) ?? null,
    rootCause: asString(pick(row, "rootCause", "root_cause")) ?? "",
    questions: asArray(row.questions).filter(isRecord).map((q) => ({
      nodeId: asString(pick(q, "nodeId", "node_id")) ?? "",
      prompt: asString(q.prompt) ?? "",
      answer: asString(q.answer) ?? null,
      answeredBy: asString(pick(q, "answeredBy", "answered_by")) ?? null,
      pending: asBool(q.pending),
    })),
    approvals: asArray(row.approvals).filter(isRecord).map((a) => ({
      nodeId: asString(pick(a, "nodeId", "node_id")) ?? "",
      approved: a.approved == null ? null : asBool(a.approved),
      note: asString(a.note) ?? null,
      decidedBy: asString(pick(a, "decidedBy", "decided_by")) ?? null,
      pending: asBool(a.pending),
    })),
    keyOutputs: asArray(pick(row, "keyOutputs", "key_outputs")).filter(isRecord).map((o) => ({
      nodeId: asString(pick(o, "nodeId", "node_id")) ?? "",
      summary: asString(o.summary) ?? "",
      value: asString(o.value) ?? null,
    })),
    diffs: asArray(row.diffs).filter(isRecord).map((d) => ({
      nodeId: asString(pick(d, "nodeId", "node_id")) ?? "",
      summary: asString(d.summary) ?? "",
      files: asArray(d.files).map((f) => asString(f) ?? "").filter(Boolean),
      excerpt: asString(d.excerpt) ?? "",
    })),
    actions: asArray(pick(row, "recommendedActions", "recommended_actions")).filter(isRecord).map((a) => ({
      problem: asString(a.problem) ?? "",
      command: asString(a.command) ?? "",
      needsHuman: asBool(pick(a, "needsHuman", "needs_human")),
      selfFixable: asBool(pick(a, "selfFixable", "self_fixable")),
    })),
  };
}

function extractReport(value: unknown): { title: string; html: string; sectionCount: number } | null {
  const row = rowOf(value);
  if (!row) return null;
  const html = asString(row.html);
  if (html === undefined) return null;
  return { title: asString(row.title) ?? "Report", html, sectionCount: Number(pick(row, "sectionCount", "section_count") ?? 0) };
}

function extractArtifact(value: unknown): { path: string; digest: string } | null {
  const row = rowOf(value);
  if (!row) return null;
  const path = asString(row.path);
  if (path === undefined) return null;
  return { path, digest: asString(row.digest) ?? "" };
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input,select { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
  ".input { height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); min-width:180px; }",
  ".select { height:30px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".check { display:inline-flex; align-items:center; gap:6px; color:var(--muted); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.warn { color:var(--warn); border-color:var(--warn); }",
  ".badge.err { color:var(--err); border-color:var(--err); }",
  ".main { display:grid; grid-template-columns:minmax(360px,5fr) minmax(420px,6fr); flex:1; overflow:hidden; }",
  ".runs-pane { border-right:1px solid var(--border); overflow:auto; }",
  ".content { padding:20px; overflow:auto; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px 18px; margin-bottom:16px; }",
  ".panel h2 { margin:0 0 10px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".summary { color:var(--text); font-size:14px; margin-bottom:8px; }",
  ".meta { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; }",
  "table { width:100%; border-collapse:collapse; font-size:12px; }",
  "th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }",
  "th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10px; letter-spacing:0.04em; }",
  "th.sortable { cursor:pointer; user-select:none; }",
  "th.sortable:hover { color:var(--text); }",
  ".runs-table tbody tr { cursor:pointer; }",
  ".runs-table tbody tr:hover td { background:var(--card); }",
  ".runs-table tbody tr.active td { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".mono { font-family:ui-monospace,monospace; }",
  ".tag { font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid var(--border); }",
  ".tag.pending { color:var(--warn); border-color:var(--warn); }",
  ".tag.yes { color:var(--ok); border-color:var(--ok); }",
  ".tag.no { color:var(--err); border-color:var(--err); }",
  ".tag.human { color:var(--warn); border-color:var(--warn); }",
  ".tag.auto { color:var(--ok); border-color:var(--ok); }",
  "code { font-family:ui-monospace,monospace; font-size:12px; background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:1px 6px; }",
  ".action { padding:8px 0; border-top:1px solid var(--border); }",
  ".action:first-child { border-top:0; }",
  ".pre { font-family:ui-monospace,monospace; font-size:11px; white-space:pre; overflow:auto; max-height:260px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px; }",
  ".reportframe { width:100%; height:520px; border:1px solid var(--border); border-radius:8px; background:#fff; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".events { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); max-height:220px; overflow:auto; }",
  ".events div { padding:2px 0; border-bottom:1px solid var(--border); }",
].join("\n");

type SortKey = "started" | "workflow" | "status" | "run";

function App() {
  // Runs-first: the table is the primary surface. `selectedRunId` is the run
  // under inspection; `monitorRunId` is the monitor-workflow run whose
  // diagnosis panels we render (only when it targeted the selected run).
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [monitorRunId, setMonitorRunId] = useState<string | undefined>(undefined);
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("started");
  const [sortDesc, setSortDesc] = useState(true);
  const [autofix, setAutofix] = useState(false);
  const [showReport, setShowReport] = useState(true);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 200 } });
  const actions = useGatewayActions();
  const allRuns = (runsQuery.data ?? []) as RunSummary[];

  // `?runId=` deep link: a monitor run id selects that monitor's panels; any
  // other run id selects the run itself. Resolved once, when runs first load.
  const urlResolved = useRef(false);
  useEffect(() => {
    if (urlResolved.current || allRuns.length === 0) return;
    urlResolved.current = true;
    const fromUrl = runIdFromUrl();
    if (!fromUrl) return;
    const row = allRuns.find((r) => r.runId === fromUrl);
    if (row?.workflowKey === WORKFLOW_KEY) setMonitorRunId(fromUrl);
    else setSelectedRunId(fromUrl);
  }, [allRuns]);

  const workflows = useMemo(
    () => Array.from(new Set(allRuns.map((r) => r.workflowKey ?? "unknown"))).sort(),
    [allRuns],
  );
  const statuses = useMemo(
    () => Array.from(new Set(allRuns.map((r) => r.status ?? "unknown"))).sort(),
    [allRuns],
  );

  const visibleRuns = useMemo(() => {
    const text = filterText.trim().toLowerCase();
    const rows = allRuns.filter((r) => {
      if (statusFilter !== "all" && (r.status ?? "unknown") !== statusFilter) return false;
      if (workflowFilter !== "all" && (r.workflowKey ?? "unknown") !== workflowFilter) return false;
      if (text && !r.runId.toLowerCase().includes(text) && !(r.workflowKey ?? "").toLowerCase().includes(text)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    rows.sort((a, b) => {
      if (sortKey === "started") return ((a.createdAtMs ?? 0) - (b.createdAtMs ?? 0)) * dir;
      if (sortKey === "workflow") return (a.workflowKey ?? "").localeCompare(b.workflowKey ?? "") * dir;
      if (sortKey === "status") return (a.status ?? "").localeCompare(b.status ?? "") * dir;
      return a.runId.localeCompare(b.runId) * dir;
    });
    return rows;
  }, [allRuns, filterText, statusFilter, workflowFilter, sortKey, sortDesc]);

  const selectedRun = allRuns.find((r) => r.runId === selectedRunId);
  const runDetailQuery = useGatewayRun(selectedRunId);
  const runDetail = isRecord(runDetailQuery.data) ? runDetailQuery.data : null;
  const steps = useMemo(
    () =>
      asArray(runDetail?.steps).filter(isRecord).map((s) => ({
        id: asString(s.id) ?? "",
        state: asString(s.state) ?? "",
        attempt: Number(s.attempt ?? 0),
      })),
    [runDetail],
  );
  const stream = useGatewayRunEvents(selectedRunId, { afterSeq: 0 });
  const events = stream.events ?? [];
  const eventTail = events.slice(-12);

  // Default the monitor panels to the newest monitor run when none is chosen.
  const newestMonitorRun = allRuns.find((r) => r.workflowKey === WORKFLOW_KEY);
  const activeMonitorRunId = monitorRunId ?? newestMonitorRun?.runId;
  const activeMonitorRun = allRuns.find((r) => r.runId === activeMonitorRunId);

  const gatherOut = useGatewayNodeOutput({ runId: activeMonitorRunId, nodeId: "gather", iteration: 0 });
  const diagnoseOut = useGatewayNodeOutput({ runId: activeMonitorRunId, nodeId: "diagnose", iteration: 0 });
  const fixOut = useGatewayNodeOutput({ runId: activeMonitorRunId, nodeId: "fix", iteration: 0 });
  const reportOut = useGatewayNodeOutput({ runId: activeMonitorRunId, nodeId: "report", iteration: 0 });
  const artifactOut = useGatewayNodeOutput({ runId: activeMonitorRunId, nodeId: "artifact", iteration: 0 });

  const gather = rowOf(gatherOut.data);
  const monitorTargetRunId = gather ? asString(pick(gather, "runId", "run_id")) : undefined;
  // Only show diagnosis panels when the monitor actually analyzed the selected run.
  const monitorMatchesSelection = !!selectedRunId && monitorTargetRunId === selectedRunId;
  const diagnosis = monitorMatchesSelection ? extractDiagnosis(diagnoseOut.data) : null;
  const fix = monitorMatchesSelection ? rowOf(fixOut.data) : null;
  const report = monitorMatchesSelection ? extractReport(reportOut.data) : null;
  const artifact = monitorMatchesSelection ? extractArtifact(artifactOut.data) : null;

  const runningMonitors = allRuns.filter(
    (r) => r.workflowKey === WORKFLOW_KEY && (r.status ?? "").toLowerCase() === "running",
  );

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      runDetailQuery.refetch?.(),
      gatherOut.refetch(),
      diagnoseOut.refetch(),
      fixOut.refetch(),
      reportOut.refetch(),
      artifactOut.refetch(),
    ]);
  }

  async function monitorSelected() {
    if (!selectedRunId) return;
    // Each launch starts a NEW durable monitor run — confirm before stacking.
    if (
      runningMonitors.length > 0 &&
      !window.confirm(
        `${runningMonitors.length} monitor run(s) are already running. Start another one for ${shortRunId(selectedRunId)}?`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const run = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: { autofix, targetRunId: selectedRunId },
      });
      setMonitorRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDesc((v) => !v);
    else {
      setSortKey(key);
      setSortDesc(key === "started");
    }
  }
  const arrow = (key: SortKey) => (sortKey === key ? (sortDesc ? " ▾" : " ▴") : "");

  return (
    <main className="shell" data-testid="monitor-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Runs</h1>
          <span className="pill">{visibleRuns.length} / {allRuns.length} runs</span>
          {runningMonitors.length > 0 ? <span className="pill">{runningMonitors.length} monitor(s) running</span> : null}
        </div>
        <div className="toolbar">
          <input
            className="input"
            data-testid="monitor-filter"
            value={filterText}
            onChange={(e) => setFilterText(e.currentTarget.value)}
            placeholder="filter by run id or workflow"
          />
          <select className="select" data-testid="monitor-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.currentTarget.value)}>
            <option value="all">all statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="select" data-testid="monitor-workflow-filter" value={workflowFilter} onChange={(e) => setWorkflowFilter(e.currentTarget.value)}>
            <option value="all">all workflows</option>
            {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <button className="button" data-testid="monitor-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
      </header>

      <div className="main">
        <div className="runs-pane">
          <table className="runs-table" data-testid="monitor-runs-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => sortBy("run")}>Run{arrow("run")}</th>
                <th className="sortable" onClick={() => sortBy("workflow")}>Workflow{arrow("workflow")}</th>
                <th className="sortable" onClick={() => sortBy("status")}>Status{arrow("status")}</th>
                <th className="sortable" onClick={() => sortBy("started")}>Started{arrow("started")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((r) => (
                <tr
                  key={r.runId}
                  className={r.runId === selectedRunId ? "active" : ""}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  <td className="mono">{shortRunId(r.runId)}</td>
                  <td className="mono">{r.workflowKey ?? "—"}</td>
                  <td><span className={"badge " + runStatusClass(r.status)}>{r.status ?? "?"}</span></td>
                  <td className="mono">{timeAgo(r.createdAtMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRuns.length === 0 ? <div className="empty">No runs match the current filter.</div> : null}
        </div>

        <div className="content">
          {!selectedRun ? (
            <div className="empty" data-testid="monitor-empty">
              <div>Select a run to inspect it.</div>
              <div style={{ maxWidth: 460, margin: "8px auto 0", fontSize: 12 }}>
                Pick any run from the table to see its steps and live events, then <b>Monitor this run</b> to
                launch a diagnosis: run state, health, pending questions/approvals, key outputs, diffs, and an
                HTML report. Tick <b>autofix</b> to let it apply the smallest safe repair behind an approval gate.
              </div>
            </div>
          ) : (
            <>
              <section className="panel" data-testid="monitor-run-detail">
                <h2>Run</h2>
                <div className="summary mono" style={{ fontSize: 13 }}>{selectedRun.runId}</div>
                <div className="meta" style={{ marginBottom: 10 }}>
                  <span className={"badge " + runStatusClass(selectedRun.status)}>{selectedRun.status ?? "?"}</span>
                  {"  "}· {selectedRun.workflowKey ?? "unknown workflow"} · started {timeAgo(selectedRun.createdAtMs)} · {events.length} events
                </div>
                <div className="toolbar">
                  <label className="check"><input type="checkbox" checked={autofix} onChange={(e) => setAutofix(e.currentTarget.checked)} /> autofix</label>
                  <button className="button primary" data-testid="monitor-launch" onClick={() => void monitorSelected()} disabled={busy}>
                    Monitor this run
                  </button>
                  {activeMonitorRun && monitorMatchesSelection ? (
                    <span className="pill">monitor {shortRunId(activeMonitorRun.runId)} · {activeMonitorRun.status ?? "?"}</span>
                  ) : null}
                </div>
              </section>

              {steps.length > 0 ? (
                <section className="panel" data-testid="monitor-steps">
                  <h2>Steps</h2>
                  <table>
                    <thead><tr><th>Node</th><th>State</th><th>Attempt</th></tr></thead>
                    <tbody>
                      {steps.map((s, i) => (
                        <tr key={s.id + ":" + i}>
                          <td className="mono">{s.id}</td>
                          <td><span className={"badge " + runStatusClass(s.state === "in-progress" ? "running" : s.state)}>{s.state}</span></td>
                          <td className="mono">{s.attempt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {eventTail.length > 0 ? (
                <section className="panel" data-testid="monitor-events">
                  <h2>Recent events</h2>
                  <div className="events">
                    {eventTail.map((e, i) => {
                      const row: Record<string, unknown> = isRecord(e) ? e : {};
                      return (
                        <div key={i}>
                          #{asString(row.seq) ?? "?"} {asString(row.type) ?? "event"}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {monitorMatchesSelection && gather ? (
                <section className="panel" data-testid="monitor-state">
                  <h2>Monitor: run state</h2>
                  <div className="summary">{asString(gather.summary) ?? ""}</div>
                  <div className="meta">
                    {monitorTargetRunId ?? "?"} · {asString(gather.state) ?? "unknown"} · {String(asString(pick(gather, "ageMinutes", "age_minutes")) ?? "0")}m idle
                  </div>
                </section>
              ) : null}

              {selectedRunId && !monitorMatchesSelection ? (
                <section className="panel">
                  <h2>Monitor</h2>
                  <div className="meta">No monitor diagnosis for this run yet — click <b>Monitor this run</b> above.</div>
                </section>
              ) : null}

              {diagnosis ? (
                <section className="panel" data-testid="monitor-diagnosis">
                  <h2>Diagnosis <span className={"badge " + healthClass(diagnosis.health)} data-testid="monitor-health">{diagnosis.health}</span></h2>
                  <div className="summary">{diagnosis.summary}</div>
                  {diagnosis.waitingOn ? <div className="meta">Waiting on: {diagnosis.waitingOn}</div> : null}
                  {diagnosis.rootCause ? <div className="meta">Root cause: {diagnosis.rootCause}</div> : null}
                </section>
              ) : null}

              {diagnosis && diagnosis.questions.length > 0 ? (
                <section className="panel" data-testid="monitor-questions">
                  <h2>Questions &amp; answers</h2>
                  <table>
                    <thead><tr><th>Node</th><th>Question</th><th>Answer</th><th>By</th></tr></thead>
                    <tbody>
                      {diagnosis.questions.map((q, i) => (
                        <tr key={q.nodeId + ":" + i}>
                          <td className="mono">{q.nodeId}</td>
                          <td>{q.prompt}</td>
                          <td>{q.pending ? <span className="tag pending">pending</span> : (q.answer ?? "—")}</td>
                          <td className="mono">{q.answeredBy ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {diagnosis && diagnosis.approvals.length > 0 ? (
                <section className="panel" data-testid="monitor-approvals">
                  <h2>Approval gates</h2>
                  <table>
                    <thead><tr><th>Node</th><th>Decision</th><th>Note</th><th>By</th></tr></thead>
                    <tbody>
                      {diagnosis.approvals.map((a, i) => (
                        <tr key={a.nodeId + ":" + i}>
                          <td className="mono">{a.nodeId}</td>
                          <td>{a.pending ? <span className="tag pending">pending</span> : a.approved ? <span className="tag yes">approved</span> : <span className="tag no">denied</span>}</td>
                          <td>{a.note ?? "—"}</td>
                          <td className="mono">{a.decidedBy ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {diagnosis && diagnosis.keyOutputs.length > 0 ? (
                <section className="panel" data-testid="monitor-outputs">
                  <h2>Task outputs</h2>
                  <table>
                    <thead><tr><th>Node</th><th>Summary</th><th>Value</th></tr></thead>
                    <tbody>
                      {diagnosis.keyOutputs.map((o, i) => (
                        <tr key={o.nodeId + ":" + i}>
                          <td className="mono">{o.nodeId}</td>
                          <td>{o.summary}</td>
                          <td className="mono">{o.value ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              {diagnosis && diagnosis.diffs.length > 0 ? (
                <section className="panel" data-testid="monitor-diffs">
                  <h2>Code diffs</h2>
                  {diagnosis.diffs.map((d, i) => (
                    <div key={d.nodeId + ":" + i} style={{ marginBottom: 12 }}>
                      <div className="meta"><b className="mono">{d.nodeId}</b> · {d.summary} · {d.files.join(", ")}</div>
                      {d.excerpt ? <pre className="pre">{d.excerpt}</pre> : null}
                    </div>
                  ))}
                </section>
              ) : null}

              {diagnosis && diagnosis.actions.length > 0 ? (
                <section className="panel" data-testid="monitor-actions">
                  <h2>Recommended actions</h2>
                  {diagnosis.actions.map((a, i) => (
                    <div className="action" key={i}>
                      <div>{a.problem} <span className={"tag " + (a.needsHuman ? "human" : "auto")}>{a.needsHuman ? "human" : "auto"}</span></div>
                      {a.command ? <div style={{ marginTop: 4 }}><code>{a.command}</code></div> : null}
                    </div>
                  ))}
                </section>
              ) : null}

              {fix ? (
                <section className="panel" data-testid="monitor-fix">
                  <h2>What the monitor fixed</h2>
                  <div className="summary">{asString(fix.summary) ?? ""}</div>
                  <div className="meta">
                    applied: {String(asBool(fix.applied))} · resumed: {String(asBool(fix.resumed))}
                    {asString(pick(fix, "stillNeedsHuman", "still_needs_human")) ? " · still needs human: " + asString(pick(fix, "stillNeedsHuman", "still_needs_human")) : ""}
                  </div>
                </section>
              ) : null}

              {report ? (
                <section className="panel" data-testid="monitor-report">
                  <h2>
                    Report
                    <button className="button" style={{ float: "right", height: 24 }} onClick={() => setShowReport((v) => !v)}>
                      {showReport ? "hide" : "show"}
                    </button>
                  </h2>
                  <div className="meta">{report.title} · {report.sectionCount} sections{artifact ? " · " + artifact.path : ""}</div>
                  {showReport ? <iframe className="reportframe" title="monitor report" sandbox="" srcDoc={report.html} data-testid="monitor-report-frame" /> : null}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
