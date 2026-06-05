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

const WORKFLOW_KEY = "research";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

type ResearchOutput = { summary: string; keyFindings: string[] };
function extractResearch(value: unknown): ResearchOutput | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const keyFindings = Array.isArray(row.keyFindings)
    ? row.keyFindings.filter((f): f is string => typeof f === "string")
    : [];
  return { summary, keyFindings };
}

function extractPrompt(runData: unknown): string | undefined {
  if (!isRecord(runData)) return undefined;
  const direct = asString(runData.prompt);
  if (direct !== undefined) return direct;
  const input = isRecord(runData.input) ? runData.input : undefined;
  if (input) {
    const fromInput = asString(input.prompt);
    if (fromInput !== undefined) return fromInput;
  }
  return undefined;
}

function extractTimes(runData: unknown, fallbackCreated: number | undefined) {
  const r = isRecord(runData) ? runData : {};
  const started =
    asNumber(r.startedAt) ?? asNumber(r.startedAtMs) ?? asNumber(r.createdAtMs) ?? asNumber(r.createdAt) ?? fallbackCreated;
  const finished = asNumber(r.finishedAt) ?? asNumber(r.finishedAtMs);
  return { started, finished };
}

function formatClock(ms: number | undefined) {
  if (ms === undefined) return "--";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "--";
  }
}
function formatElapsed(started: number | undefined, finished: number | undefined) {
  if (started === undefined) return "--";
  const end = finished ?? Date.now();
  const secs = Math.max(0, Math.round((end - started) / 1000));
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return mins + "m " + rem + "s";
}

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "waiting-approval" || status === "waiting-timer") return "running";
  return "";
}
function isRunning(status: string | undefined) {
  return statusClass(status) === "running";
}
function isFinished(status: string | undefined) {
  return status === "finished";
}

function eventLabel(ev: unknown): { text: string; kind: string } {
  if (!isRecord(ev)) return { text: String(ev), kind: "" };
  const type = asString(ev.type) ?? asString(ev.kind) ?? "event";
  const node = asString(ev.nodeId) ?? asString(ev.taskId);
  const message = asString(ev.message) ?? asString(ev.text) ?? asString(ev.chunk);
  const parts = [type];
  if (node) parts.push(node);
  const head = parts.join(" · ");
  return { text: message ? head + " — " + message : head, kind: type };
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; --accent:#7dd3fc; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; display:flex; align-items:center; gap:8px; }",
  ".glyph { color:var(--accent); }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); font-family:ui-monospace,monospace; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:460px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button.ghost { background:transparent; }",
  ".button.tiny { height:22px; padding:0 8px; font-size:11px; border-radius:5px; }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:1fr 260px; flex:1; overflow:hidden; }",
  ".content { padding:18px 20px; overflow:auto; display:flex; flex-direction:column; gap:16px; }",
  ".statusbar { display:flex; align-items:center; gap:18px; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:12px 16px; flex-wrap:wrap; }",
  ".stat { display:flex; flex-direction:column; gap:2px; }",
  ".stat .k { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); }",
  ".stat .v { font-size:13px; font-weight:600; }",
  ".statusbar .spacer { flex:1; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }",
  ".card h2 { margin:0 0 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); display:flex; align-items:center; justify-content:space-between; }",
  ".query-text { font-size:14px; line-height:1.55; white-space:pre-wrap; word-break:break-word; }",
  ".error-text { color:var(--err); font-size:13px; white-space:pre-wrap; }",
  ".stream { background:#0a0a0c; border:1px solid var(--border); border-radius:10px; display:flex; flex-direction:column; min-height:140px; max-height:300px; overflow:hidden; }",
  ".stream-head { padding:10px 14px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); border-bottom:1px solid var(--border); display:flex; justify-content:space-between; }",
  ".stream-body { overflow:auto; padding:8px 0; font-family:ui-monospace,monospace; font-size:11.5px; }",
  ".stream-line { padding:3px 14px; color:var(--muted); white-space:pre-wrap; word-break:break-word; border-left:2px solid transparent; }",
  ".stream-line.task { color:var(--accent); border-left-color:var(--accent); }",
  ".stream-empty { padding:24px 14px; color:var(--muted); text-align:center; }",
  ".summary-text { font-size:15px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }",
  ".findings { list-style:none; margin:10px 0 0; padding:0; }",
  ".findings li { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--border); }",
  ".findings li:last-child { border-bottom:0; }",
  ".find-dot { flex:0 0 8px; width:8px; height:8px; margin-top:6px; border-radius:50%; background:var(--accent); }",
  ".find-text { flex:1; line-height:1.5; }",
  ".find-copy { flex:0 0 auto; opacity:0.6; }",
  ".find-copy:hover { opacity:1; }",
  ".findings-empty { color:var(--muted); padding:10px 0; font-style:italic; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .launch-form { display:flex; gap:8px; max-width:520px; margin:16px auto 0; }",
  ".empty .launch-form input { flex:1; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Research the given topic.");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const researchRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter(
        (r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );

  const activeRunId = selectedRunId ?? runIdFromUrl() ?? researchRuns[0]?.runId;
  const activeSummary = researchRuns.find((r) => r.runId === activeRunId);

  const runQuery = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const researchOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "research", iteration: 0 });
  const research = useMemo(() => extractResearch(researchOutput.data), [researchOutput.data]);

  const runData = runQuery.data;
  const status = asString(isRecord(runData) ? runData.status : undefined) ?? activeSummary?.status;
  const errorMsg = asString(isRecord(runData) ? runData.error : undefined);
  const queryPrompt = extractPrompt(runData);
  const { started, finished } = extractTimes(runData, activeSummary?.createdAtMs);
  const events = stream.events ?? [];

  async function refresh() {
    await Promise.all([runsQuery.refetch(), runQuery.refetch?.(), researchOutput.refetch()]);
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
  async function rewind() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      if (typeof actions.rewindRun === "function") {
        await actions.rewindRun({ runId: activeRunId, frameNo: 0, confirm: true });
      } else {
        await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt: queryPrompt ?? prompt } });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  function copy(text: string, tag: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(text);
      }
    } catch {
      /* ignore */
    }
    setCopied(tag);
  }

  const hasActiveRun = Boolean(activeRunId);

  return (
    <main className="shell" data-testid="research-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>
            <span className="glyph">◎</span> Research
          </h1>
          <span className="pill" data-testid="research-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {status ? (
            <span className={"badge " + statusClass(status)} data-testid="research-status">
              {status}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="research-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should we research?"
          />
          <button className="button" data-testid="research-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button
            className="button primary"
            data-testid="research-launch"
            onClick={() => void launch()}
            disabled={busy}
          >
            New Research
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {hasActiveRun ? (
            <>
              <section className="statusbar" data-testid="research-statusbar">
                <div className="stat">
                  <span className="k">Status</span>
                  <span className={"badge " + statusClass(status)}>{status ?? "idle"}</span>
                </div>
                <div className="stat">
                  <span className="k">Started</span>
                  <span className="v">{formatClock(started)}</span>
                </div>
                <div className="stat">
                  <span className="k">Elapsed</span>
                  <span className="v">{formatElapsed(started, finished)}</span>
                </div>
                <div className="stat">
                  <span className="k">Events</span>
                  <span className="v">{events.length}</span>
                </div>
                <div className="spacer" />
                {isRunning(status) ? (
                  <button
                    className="button danger"
                    data-testid="research-cancel"
                    onClick={() => void cancel()}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                ) : null}
                {isFinished(status) ? (
                  <button
                    className="button ghost"
                    data-testid="research-rewind"
                    onClick={() => void rewind()}
                    disabled={busy}
                  >
                    Rewind
                  </button>
                ) : null}
              </section>

              <section className="card" data-testid="research-query">
                <h2>Research query</h2>
                <div className="query-text">{queryPrompt ?? "(no prompt recorded for this run)"}</div>
                {errorMsg ? <div className="error-text" style={{ marginTop: 10 }}>{errorMsg}</div> : null}
              </section>

              <section className="stream" data-testid="research-stream">
                <div className="stream-head">
                  <span>Progress stream</span>
                  <span>{events.length} events</span>
                </div>
                <div className="stream-body">
                  {events.length === 0 ? (
                    <div className="stream-empty">
                      {isRunning(status) ? "Waiting for the agent to report progress…" : "No progress events recorded."}
                    </div>
                  ) : (
                    events.map((ev, i) => {
                      const { text, kind } = eventLabel(ev);
                      const isTask = kind.toLowerCase().indexOf("task") >= 0;
                      return (
                        <div key={i} className={"stream-line" + (isTask ? " task" : "")}>
                          {text}
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              <section className="card" data-testid="research-summary">
                <h2>
                  <span>Findings</span>
                  {research ? (
                    <button
                      className="button ghost tiny"
                      data-testid="research-copy-summary"
                      onClick={() => copy(research.summary, "summary")}
                    >
                      {copied === "summary" ? "Copied" : "Copy summary"}
                    </button>
                  ) : null}
                </h2>
                {research ? (
                  <>
                    <div className="summary-text" data-testid="research-summary-text">
                      {research.summary}
                    </div>
                    {research.keyFindings.length > 0 ? (
                      <ul className="findings" data-testid="research-findings">
                        {research.keyFindings.map((f, i) => (
                          <li key={i} data-testid="research-finding">
                            <span className="find-dot" />
                            <span className="find-text">{f}</span>
                            <button
                              className="button ghost tiny find-copy"
                              onClick={() => copy(f, "finding-" + i)}
                            >
                              {copied === "finding-" + i ? "Copied" : "Copy"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="findings-empty" data-testid="research-findings-empty">
                        No discrete key findings were extracted for this run.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="findings-empty" data-testid="research-summary-pending">
                    {isRunning(status)
                      ? "Research in progress — findings will appear here when the agent finishes."
                      : "No research output is available for this run yet."}
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="empty" data-testid="research-empty">
              <div>Select a research run from the history, or launch a new research run by entering a prompt.</div>
              <div className="launch-form">
                <input
                  className="prompt"
                  data-testid="research-empty-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.currentTarget.value)}
                  placeholder="What should we research?"
                />
                <button
                  className="button primary"
                  data-testid="research-launch-empty"
                  onClick={() => void launch()}
                  disabled={busy}
                >
                  Start Research
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Research history</div>
          {researchRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"research-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {researchRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
