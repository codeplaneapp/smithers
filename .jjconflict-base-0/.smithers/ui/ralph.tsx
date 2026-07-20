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

const WORKFLOW_KEY = "ralph";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function extractSummary(value: unknown): string | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  return asString(row.summary) ?? null;
}

type IterationEvent = { seq: number; iteration: number; label: string; tsMs?: number };

function extractIterations(events: unknown[]): IterationEvent[] {
  const out: IterationEvent[] = [];
  for (const raw of events) {
    if (!isRecord(raw)) continue;
    const nodeId = asString(raw.nodeId) ?? asString(raw.node);
    if (nodeId !== "ralph") continue;
    const kind = asString(raw.type) ?? asString(raw.kind) ?? "";
    if (kind.indexOf("complete") === -1 && kind.indexOf("finish") === -1 && kind.indexOf("output") === -1) continue;
    const iterRaw = raw.iteration ?? raw.iter;
    const iteration = typeof iterRaw === "number" ? iterRaw : out.length;
    const seq = typeof raw.seq === "number" ? raw.seq : out.length;
    const tsMs = typeof raw.tsMs === "number" ? raw.tsMs : typeof raw.timestampMs === "number" ? raw.timestampMs : undefined;
    out.push({ seq, iteration, label: kind, tsMs });
  }
  return out;
}

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function fmtTime(ms: number | undefined) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch (_e) {
    return "";
  }
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input,textarea { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".sub { font-size:11px; color:var(--muted); }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); color:var(--muted); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".center { display:flex; flex-direction:column; overflow:hidden; }",
  ".launch { padding:16px 20px; border-bottom:1px solid var(--border); background:var(--panel); }",
  ".launch-row { display:flex; gap:10px; align-items:flex-end; }",
  ".launch-field { flex:1; display:flex; flex-direction:column; gap:6px; }",
  ".launch-field label { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".prompt { width:100%; min-height:54px; resize:vertical; padding:8px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); }",
  ".meta { display:flex; gap:16px; margin-top:10px; align-items:center; }",
  ".meta .stat { display:flex; flex-direction:column; }",
  ".meta .stat .k { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".meta .stat .v { font-size:14px; font-weight:600; }",
  ".actions { display:flex; gap:8px; }",
  ".button { height:34px; padding:0 14px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".timeline { flex:1; overflow:auto; padding:20px; }",
  ".timeline-head { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin-bottom:14px; }",
  ".iter-card { position:relative; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px 14px 18px; margin-bottom:14px; }",
  ".iter-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; border-radius:3px 0 0 3px; background:var(--primary); }",
  ".iter-card .row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }",
  ".iter-tag { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; color:var(--primary); }",
  ".iter-ts { font-size:11px; color:var(--muted); font-family:ui-monospace,monospace; }",
  ".iter-summary { font-size:14px; line-height:1.55; white-space:pre-wrap; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:16px; }",
  ".empty h3 { color:var(--text); margin:0 0 8px; font-size:15px; }",
  ".empty p { max-width:420px; margin:0 auto; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Continue working on the current task.");
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const ralphRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? ralphRuns[0]?.runId;
  const activeRun = ralphRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const ralphOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "ralph", iteration: 0 });

  const events = stream.events ?? [];
  const iterations = useMemo(() => extractIterations(events), [events]);
  const latestSummary = useMemo(() => extractSummary(ralphOutput.data), [ralphOutput.data]);
  const iterationCount = iterations.length > 0 ? iterations.length : latestSummary ? 1 : 0;
  const isRunning = statusClass(activeRun?.status) === "running";

  async function refresh() {
    await Promise.all([runsQuery.refetch(), ralphOutput.refetch()]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } });
      setSelectedRunId(run.runId);
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
  async function resume() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.resumeRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" data-testid="ralph-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Ralph</h1>
          <span className="sub">Continuous maintenance loop</span>
          <span className="pill" data-testid="ralph-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="ralph-status">{activeRun.status ?? "idle"}</span>
          ) : null}
        </div>
        <div className="actions">
          <button className="button" data-testid="ralph-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {isRunning ? (
            <button className="button danger" data-testid="ralph-cancel" onClick={() => void cancel()} disabled={busy}>Cancel loop</button>
          ) : null}
          {activeRun && statusClass(activeRun.status) === "failed" ? (
            <button className="button" data-testid="ralph-resume" onClick={() => void resume()} disabled={busy}>Resume</button>
          ) : null}
        </div>
      </header>

      <div className="main">
        <div className="center">
          <div className="launch" data-testid="ralph-launch">
            <div className="launch-row">
              <div className="launch-field">
                <label htmlFor="ralph-prompt-input">Loop prompt</label>
                <textarea
                  id="ralph-prompt-input"
                  className="prompt"
                  data-testid="ralph-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.currentTarget.value)}
                  placeholder="Continue working on the current task."
                />
              </div>
              <button className="button primary" data-testid="ralph-launch-button" onClick={() => void launch()} disabled={busy}>
                Start loop
              </button>
            </div>
            <div className="meta">
              <div className="stat">
                <span className="k">Status</span>
                <span className="v">{activeRun?.status ?? "idle"}</span>
              </div>
              <div className="stat">
                <span className="k">Iterations</span>
                <span className="v" data-testid="ralph-iteration-count">{iterationCount}</span>
              </div>
              <div className="stat">
                <span className="k">Events</span>
                <span className="v">{events.length}</span>
              </div>
            </div>
          </div>

          <div className="timeline" data-testid="ralph-timeline">
            <div className="timeline-head">Iteration timeline (newest first)</div>
            {latestSummary ? (
              <div className="iter-card" data-testid="ralph-latest-iteration">
                <div className="row">
                  <span className="iter-tag">Latest iteration</span>
                  <span className="iter-ts">{fmtTime(activeRun?.createdAtMs)}</span>
                </div>
                <div className="iter-summary" data-testid="ralph-summary">{latestSummary}</div>
              </div>
            ) : null}
            {iterations
              .slice()
              .reverse()
              .map((it) => (
                <div className="iter-card" key={it.seq} data-testid="ralph-iteration-event">
                  <div className="row">
                    <span className="iter-tag">Iteration {it.iteration + 1}</span>
                    <span className="iter-ts">{fmtTime(it.tsMs)}</span>
                  </div>
                  <div className="iter-summary">{it.label}</div>
                </div>
              ))}
            {!latestSummary && iterations.length === 0 ? (
              <div className="empty" data-testid="ralph-empty">
                <h3>{activeRunId ? "Waiting for the first iteration…" : "No loop running"}</h3>
                <p>
                  Ralph runs a single task in an infinite loop, posting a fresh summary after every iteration. Enter a
                  prompt and start the loop to watch each iteration land here. Cancel whenever the work is done.
                </p>
                <button className="button primary" data-testid="ralph-launch-empty" onClick={() => void launch()} disabled={busy}>
                  Start loop
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="sidebar">
          <div className="side-head">Run history</div>
          {ralphRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"ralph-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {ralphRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
