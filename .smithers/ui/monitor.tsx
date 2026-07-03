/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
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
  ".input { height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); min-width:200px; }",
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
  ".main { display:grid; grid-template-columns:1fr 240px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px 18px; margin-bottom:16px; }",
  ".panel h2 { margin:0 0 10px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".summary { color:var(--text); font-size:14px; margin-bottom:8px; }",
  ".meta { color:var(--muted); font-size:12px; font-family:ui-monospace,monospace; }",
  "table { width:100%; border-collapse:collapse; font-size:12px; }",
  "th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }",
  "th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:10px; letter-spacing:0.04em; }",
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
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [target, setTarget] = useState("");
  const [autofix, setAutofix] = useState(false);
  const [showReport, setShowReport] = useState(true);
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const monitorRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? monitorRuns[0]?.runId;
  const activeRun = monitorRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const eventCount = (stream.events ?? []).length;

  const gatherOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "gather", iteration: 0 });
  const diagnoseOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "diagnose", iteration: 0 });
  const fixOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "fix", iteration: 0 });
  const reportOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "report", iteration: 0 });
  const artifactOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "artifact", iteration: 0 });

  const gather = rowOf(gatherOut.data);
  const targetRunId = gather ? asString(pick(gather, "runId", "run_id")) : undefined;
  const targetState = gather ? asString(gather.state) : undefined;
  const diagnosis = extractDiagnosis(diagnoseOut.data);
  const fix = rowOf(fixOut.data);
  const report = extractReport(reportOut.data);
  const artifact = extractArtifact(artifactOut.data);

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      gatherOut.refetch(),
      diagnoseOut.refetch(),
      fixOut.refetch(),
      reportOut.refetch(),
      artifactOut.refetch(),
    ]);
  }
  const runningMonitors = monitorRuns.filter((r) => (r.status ?? "").toLowerCase() === "running");

  async function launch() {
    // Each click starts a NEW durable monitor run. Guard against accidentally
    // stacking duplicates: with one already running, make the user confirm.
    if (
      runningMonitors.length > 0 &&
      !window.confirm(
        `${runningMonitors.length} monitor run(s) are already running. ` +
          "Start another one anyway? (Each click of Monitor launches a new run.)",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const input: Record<string, unknown> = { autofix };
      if (target.trim()) input.targetRunId = target.trim();
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const hasData = gather || diagnosis || report;

  return (
    <main className="shell" data-testid="monitor-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Monitor</h1>
          <span className="pill" data-testid="monitor-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {targetRunId ? <span className="pill" data-testid="monitor-target">target {shortRunId(targetRunId)}</span> : null}
          {diagnosis ? (
            <span className={"badge " + healthClass(diagnosis.health)} data-testid="monitor-health">{diagnosis.health}</span>
          ) : activeRun ? (
            <span className={"badge " + runStatusClass(activeRun.status)}>{activeRun.status ?? "idle"}</span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="input"
            data-testid="monitor-target-input"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
            placeholder="target run id (blank = latest active)"
          />
          <label className="check"><input type="checkbox" checked={autofix} onChange={(e) => setAutofix(e.currentTarget.checked)} /> autofix</label>
          <button className="button" data-testid="monitor-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          <button className="button primary" data-testid="monitor-launch" onClick={() => void launch()} disabled={busy}>Start monitor run</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {gather ? (
            <section className="panel" data-testid="monitor-state">
              <h2>Run state</h2>
              <div className="summary">{asString(gather.summary) ?? ""}</div>
              <div className="meta">
                {targetRunId ?? "?"} · {targetState ?? "unknown"} · {String(asString(pick(gather, "ageMinutes", "age_minutes")) ?? "0")}m idle
              </div>
            </section>
          ) : null}

          {diagnosis ? (
            <section className="panel" data-testid="monitor-diagnosis">
              <h2>Diagnosis</h2>
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

          {!hasData ? (
            <div className="empty" data-testid="monitor-empty">
              <div>{activeRunId ? "Monitoring…" : "No monitor runs yet."}</div>
              <div style={{ maxWidth: 460, margin: "8px auto 0", fontSize: 12 }}>
                Enter a target run id (or leave blank for the latest active run), then Monitor. The monitor gathers
                the run's state, diagnoses its health, answers questions / approvals / outputs / diffs, and renders an
                HTML report. Tick <b>autofix</b> to let it apply the smallest safe repair behind an approval gate.
              </div>
            </div>
          ) : null}

          <div className="meta" style={{ marginTop: 4 }}>{eventCount} monitor events</div>
        </div>

        <aside className="sidebar">
          <div className="side-head">Monitor runs</div>
          {monitorRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono" style={{ fontSize: 11 }}>{shortRunId(r.runId)}</span>
              <span className={"badge " + runStatusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {monitorRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
