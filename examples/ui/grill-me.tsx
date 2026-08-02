/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { WorkflowUiStyles } from "smthrs/gateway-ui";

const WORKFLOW_KEY = "grill-me";
const GRILL_NODE_ID = "grill-me:grill";
const MAX_TRACKED_ITERATIONS = 8;

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

type GrillRow = {
  iteration: number;
  question: string;
  recommendedAnswer: string | null;
  branch: string | null;
  resolved: boolean;
  questionsAsked: number;
  sharedUnderstanding: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function extractRow(value: unknown, iteration: number): GrillRow | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const question = asString(row.question);
  if (question === undefined) return null;
  return {
    iteration,
    question,
    recommendedAnswer: asNullableString(row.recommendedAnswer),
    branch: asNullableString(row.branch),
    resolved: row.resolved === true,
    questionsAsked: typeof row.questionsAsked === "number" ? row.questionsAsked : 0,
    sharedUnderstanding: asNullableString(row.sharedUnderstanding),
  };
}

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "paused" || status === "waiting") return "paused";
  return "";
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; flex-wrap:wrap; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".metrics { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
  ".metric { font-size:11px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".metric b { color:var(--text); font-weight:600; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; flex-wrap:wrap; }",
  ".prompt { flex:1; max-width:360px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".badge.paused { color:var(--primary); border-color:var(--primary); }",
  ".main { display:grid; grid-template-columns:1fr 360px; flex:1; overflow:hidden; }",
  ".history { padding:20px; overflow:auto; border-right:1px solid var(--border); }",
  ".history-head { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:0 0 14px; }",
  ".qa { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin-bottom:12px; position:relative; }",
  ".qa.resolved { border-color:var(--ok); }",
  ".qa-meta { display:flex; align-items:center; gap:8px; margin-bottom:8px; }",
  ".iter-chip { font-size:11px; font-weight:600; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:2px 8px; }",
  ".branch-chip { font-size:11px; color:var(--primary); border:1px solid var(--primary); border-radius:5px; padding:2px 8px; }",
  ".qa-question { font-size:14px; line-height:1.5; margin-bottom:8px; }",
  ".qa-hint { font-size:12px; color:var(--muted); border-left:2px solid var(--border); padding-left:10px; }",
  ".qa-hint b { color:var(--ok); font-weight:600; }",
  ".rail { background:var(--panel); display:flex; flex-direction:column; overflow:auto; }",
  ".rail-section { padding:16px; border-bottom:1px solid var(--border); }",
  ".rail-section h2 { margin:0 0 10px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".current-q { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }",
  ".current-q .q { font-size:16px; line-height:1.5; margin-bottom:10px; }",
  ".current-q .hint { font-size:12px; color:var(--muted); }",
  ".current-q .hint b { color:var(--ok); }",
  ".understanding { font-size:13px; line-height:1.6; color:var(--text); white-space:pre-wrap; }",
  ".resolved-banner { background:rgba(74,222,128,0.08); border:1px solid var(--ok); border-radius:10px; padding:14px 16px; color:var(--ok); }",
  ".resolved-banner b { display:block; margin-bottom:6px; }",
  ".resolved-banner span { color:var(--text); }",
  ".actions { display:flex; gap:8px; flex-wrap:wrap; }",
  ".empty { color:var(--muted); text-align:center; padding:32px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".spinner { width:18px; height:18px; border-radius:50%; border:2px solid var(--border); border-top-color:var(--primary); display:inline-block; animation:spin 0.8s linear infinite; vertical-align:middle; margin-right:8px; }",
  "@keyframes spin { to { transform:rotate(360deg); } }",
  ".runs { padding:6px 0; }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  "@media (max-width:880px) { .main { grid-template-columns:1fr; } .history { border-right:0; border-bottom:1px solid var(--border); } }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Describe what you want to get grilled on.");
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const grillRuns = useMemo(
    () =>
      ((runsQuery.data ?? []) as RunSummary[]).filter(
        (r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY,
      ),
    [runsQuery.data],
  );

  const activeRunId = selectedRunId ?? runIdFromUrl() ?? grillRuns[0]?.runId;
  const activeRun = grillRuns.find((r) => r.runId === activeRunId);
  const runDetail = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });

  // Hooks cannot run in a loop, so fetch a fixed window of iterations.
  // Iteration 0 is the primary output region per the deep-link contract.
  const iter0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 0 });
  const iter1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 1 });
  const iter2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 2 });
  const iter3 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 3 });
  const iter4 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 4 });
  const iter5 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 5 });
  const iter6 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 6 });
  const iter7 = useGatewayNodeOutput({ runId: activeRunId, nodeId: GRILL_NODE_ID, iteration: 7 });
  const iterQueries = [iter0, iter1, iter2, iter3, iter4, iter5, iter6, iter7];

  const rows = useMemo(() => {
    const out: GrillRow[] = [];
    for (let i = 0; i < MAX_TRACKED_ITERATIONS; i += 1) {
      const row = extractRow(iterQueries[i].data, i);
      if (row) out.push(row);
    }
    return out;
  }, [iter0.data, iter1.data, iter2.data, iter3.data, iter4.data, iter5.data, iter6.data, iter7.data]);

  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  const totalQuestionsAsked = latest ? latest.questionsAsked : rows.length;
  const resolved = latest ? latest.resolved : false;
  const sharedUnderstanding = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].sharedUnderstanding) return rows[i].sharedUnderstanding;
    }
    return null;
  }, [rows]);

  const runStatus =
    (isRecord(runDetail.data) ? asString(runDetail.data.status) : undefined) ?? activeRun?.status;
  const eventCount = (stream.events ?? []).length;
  const isRunning = statusClass(runStatus) === "running";
  const isPaused = statusClass(runStatus) === "paused";

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      runDetail.refetch(),
      ...iterQueries.map((q) => q.refetch()),
    ]);
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

  const hasRun = Boolean(activeRunId);
  const awaitingFirst = hasRun && rows.length === 0;

  return (
    <main className="shell" data-testid="grill-me-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Grill Me</h1>
          <span className="pill" data-testid="grill-me-runid">
            <span className="mono">{hasRun ? shortRunId(activeRunId) : "No run"}</span>
          </span>
          {hasRun ? (
            <span className={"badge " + statusClass(runStatus)} data-testid="grill-me-status">
              {resolved ? "resolved" : (runStatus ?? "idle")}
            </span>
          ) : null}
          <div className="metrics">
            <span className="metric">
              iterations <b>{rows.length}</b>
            </span>
            <span className="metric">
              questions <b>{totalQuestionsAsked}</b>
            </span>
            <span className="metric">
              events <b>{eventCount}</b>
            </span>
          </div>
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="grill-me-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should we grill you on?"
          />
          <button className="button" data-testid="grill-me-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button className="button primary" data-testid="grill-me-launch" onClick={() => void launch()} disabled={busy}>
            Start Grilling
          </button>
        </div>
      </header>

      <div className="main">
        <section className="history" data-testid="grill-me-history">
          <h2 className="history-head">Conversation history</h2>
          {rows.length > 0 ? (
            rows.map((row) => (
              <article
                key={row.iteration}
                className={"qa" + (row.resolved ? " resolved" : "")}
                data-testid="grill-me-qa"
              >
                <div className="qa-meta">
                  <span className="iter-chip">Q{row.iteration + 1}</span>
                  {row.branch ? <span className="branch-chip">{row.branch}</span> : null}
                  {row.resolved ? <span className="badge finished">resolved</span> : null}
                </div>
                <div className="qa-question">{row.question}</div>
                {row.recommendedAnswer ? (
                  <div className="qa-hint">
                    <b>Suggested:</b> {row.recommendedAnswer}
                  </div>
                ) : null}
              </article>
            ))
          ) : awaitingFirst ? (
            <div className="empty" data-testid="grill-me-loading">
              <span className="spinner" />
              Agent is forming the first question...
            </div>
          ) : (
            <div className="empty" data-testid="grill-me-empty">
              <div>No active run.</div>
              <div>Launch a grill-me workflow from the Smithers CLI or dashboard.</div>
              <button className="button primary" data-testid="grill-me-launch-empty" onClick={() => void launch()} disabled={busy}>
                Start Grilling
              </button>
            </div>
          )}
        </section>

        <aside className="rail">
          <div className="rail-section">
            <h2>Current question</h2>
            {latest ? (
              <div className="current-q" data-testid="grill-me-current">
                <div className="q">{latest.question}</div>
                {latest.recommendedAnswer ? (
                  <div className="hint">
                    <b>Recommended answer:</b> {latest.recommendedAnswer}
                  </div>
                ) : (
                  <div className="hint">No recommended answer yet.</div>
                )}
              </div>
            ) : (
              <div className="empty">Waiting for the first question...</div>
            )}
          </div>

          <div className="rail-section">
            <h2>Shared understanding</h2>
            {sharedUnderstanding ? (
              <div className="understanding" data-testid="grill-me-understanding">
                {sharedUnderstanding}
              </div>
            ) : (
              <div className="empty" data-testid="grill-me-understanding-empty">
                Not captured yet — the agent updates this as understanding builds.
              </div>
            )}
          </div>

          {resolved ? (
            <div className="rail-section">
              <div className="resolved-banner" data-testid="grill-me-resolved">
                <b>Grilling complete — shared understanding reached</b>
                <span>{sharedUnderstanding ?? "The agent is satisfied with the requirements."}</span>
              </div>
            </div>
          ) : null}

          <div className="rail-section">
            <h2>Actions</h2>
            <div className="actions">
              <button
                className="button danger"
                data-testid="grill-me-cancel"
                onClick={() => void cancel()}
                disabled={busy || !hasRun || !isRunning}
              >
                Cancel
              </button>
              {isPaused ? (
                <button
                  className="button primary"
                  data-testid="grill-me-resume"
                  onClick={() => void resume()}
                  disabled={busy}
                >
                  Resume
                </button>
              ) : null}
            </div>
          </div>

          <div className="rail-section">
            <h2>Recent grills</h2>
            <div className="runs">
              {grillRuns.map((r) => (
                <button
                  key={r.runId}
                  className={"run-row" + (r.runId === activeRunId ? " active" : "")}
                  data-testid={"grill-me-run-" + r.runId}
                  onClick={() => setSelectedRunId(r.runId)}
                >
                  <span className="mono">{shortRunId(r.runId)}</span>
                  <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
                </button>
              ))}
              {grillRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
