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

const WORKFLOW_KEY = "debug";
const MAX_ITERATIONS = 3;
const REVIEWER_SLOTS = [0, 1, 2];

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function rowOf(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : null;
  return row;
}

type ImplementOutput = { summary: string; filesChanged: string[]; allTestsPassing: boolean };
function extractImplement(value: unknown): ImplementOutput | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const filesChanged = Array.isArray(row.filesChanged)
    ? row.filesChanged.filter((f): f is string => typeof f === "string")
    : [];
  return { summary, filesChanged, allTestsPassing: asBool(row.allTestsPassing) ?? true };
}

type ValidateOutput = { summary: string; allPassed: boolean; failingSummary: string | null };
function extractValidate(value: unknown): ValidateOutput | null {
  const row = rowOf(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    summary,
    allPassed: asBool(row.allPassed) ?? true,
    failingSummary: asString(row.failingSummary) ?? null,
  };
}

type ReviewIssue = { severity: string; title: string; file: string | null; description: string };
type ReviewOutput = { reviewer: string; approved: boolean; feedback: string; issues: ReviewIssue[] };
function extractReview(value: unknown): ReviewOutput | null {
  const row = rowOf(value);
  if (!row) return null;
  const reviewer = asString(row.reviewer);
  if (reviewer === undefined) return null;
  const issues = Array.isArray(row.issues)
    ? row.issues.filter(isRecord).map((i) => ({
        severity: asString(i.severity) ?? "nit",
        title: asString(i.title) ?? "",
        file: asString(i.file) ?? null,
        description: asString(i.description) ?? "",
      }))
    : [];
  return {
    reviewer,
    approved: asBool(row.approved) ?? false,
    feedback: asString(row.feedback) ?? "",
    issues,
  };
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".status-row { display:flex; align-items:center; gap:10px; margin-bottom:16px; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.err { color:var(--err); border-color:var(--err); }",
  ".bug-card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:18px; }",
  ".bug-card h2 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".bug-text { font-size:14px; line-height:1.55; }",
  ".timeline { display:flex; gap:10px; margin-bottom:18px; flex-wrap:wrap; }",
  ".iter-tab { display:flex; flex-direction:column; gap:6px; min-width:120px; padding:10px 12px; border:1px solid var(--border); border-radius:9px; background:var(--panel); color:var(--text); cursor:pointer; text-align:left; }",
  ".iter-tab:hover { background:var(--card); }",
  ".iter-tab.active { border-color:var(--primary); box-shadow:inset 0 0 0 1px var(--primary); }",
  ".iter-tab .iter-label { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".iter-dots { display:flex; gap:6px; align-items:center; }",
  ".dot { width:9px; height:9px; border-radius:50%; background:var(--border); }",
  ".dot.ok { background:var(--ok); }",
  ".dot.err { background:var(--err); }",
  ".dot.pending { background:var(--muted); opacity:0.5; }",
  ".phase-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }",
  ".phase-grid.review-row { grid-template-columns:1fr; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:16px; }",
  ".panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }",
  ".panel-head h3 { margin:0; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".panel-summary { font-size:14px; line-height:1.5; }",
  ".files { list-style:none; margin:10px 0 0; padding:0; }",
  ".files li { font-family:ui-monospace,monospace; font-size:12px; padding:5px 0; border-bottom:1px solid var(--border); color:var(--text); }",
  ".files li:last-child { border-bottom:0; }",
  ".fail-box { margin-top:10px; padding:10px 12px; border:1px solid var(--err); border-radius:8px; background:rgba(248,113,113,0.08); color:var(--err); font-size:12px; white-space:pre-wrap; }",
  ".reviewers { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }",
  ".reviewer-card { border:1px solid var(--border); border-radius:9px; padding:12px 14px; background:var(--panel); }",
  ".reviewer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }",
  ".reviewer-name { font-weight:600; font-size:13px; }",
  ".reviewer-feedback { font-size:13px; color:var(--text); line-height:1.5; }",
  ".issues { list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:6px; }",
  ".issue { font-size:12px; padding:6px 8px; border-radius:6px; border:1px solid var(--border); }",
  ".issue.critical { border-color:var(--err); color:var(--err); }",
  ".issue.major { border-color:#fb923c; color:#fb923c; }",
  ".issue.minor { border-color:var(--warn); color:var(--warn); }",
  ".issue.nit { border-color:var(--border); color:var(--muted); }",
  ".sub-empty { color:var(--muted); font-size:12px; margin-top:8px; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
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

function IterationPanels(props: { runId: string; iteration: number }) {
  const { runId, iteration } = props;
  const implementOut = useGatewayNodeOutput({ runId, nodeId: "debug:implement", iteration });
  const validateOut = useGatewayNodeOutput({ runId, nodeId: "debug:validate", iteration });
  const review0 = useGatewayNodeOutput({ runId, nodeId: "debug:review:0", iteration });
  const review1 = useGatewayNodeOutput({ runId, nodeId: "debug:review:1", iteration });
  const review2 = useGatewayNodeOutput({ runId, nodeId: "debug:review:2", iteration });

  const implement = useMemo(() => extractImplement(implementOut.data), [implementOut.data]);
  const validate = useMemo(() => extractValidate(validateOut.data), [validateOut.data]);
  const reviewData = [review0.data, review1.data, review2.data];
  const reviews = useMemo(
    () => REVIEWER_SLOTS.map((i) => extractReview(reviewData[i])).filter((r): r is ReviewOutput => r !== null),
    [review0.data, review1.data, review2.data],
  );

  return (
    <>
      <div className="phase-grid">
        <div className="panel" data-testid="debug-implement-panel">
          <div className="panel-head">
            <h3>Implement · attempt {iteration + 1}</h3>
            {implement ? (
              <span className={"badge " + (implement.allTestsPassing ? "ok" : "err")}>
                {implement.allTestsPassing ? "tests pass" : "tests fail"}
              </span>
            ) : null}
          </div>
          {implement ? (
            <>
              <div className="panel-summary" data-testid="debug-implement-summary">
                {implement.summary}
              </div>
              {implement.filesChanged.length > 0 ? (
                <ul className="files" data-testid="debug-implement-files">
                  {implement.filesChanged.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              ) : (
                <div className="sub-empty" data-testid="debug-implement-files-empty">
                  No files changed in this attempt.
                </div>
              )}
            </>
          ) : (
            <div className="sub-empty">Waiting for the fix attempt…</div>
          )}
        </div>

        <div className="panel" data-testid="debug-validate-panel">
          <div className="panel-head">
            <h3>Validate · attempt {iteration + 1}</h3>
            {validate ? (
              <span className={"badge " + (validate.allPassed ? "ok" : "err")}>
                {validate.allPassed ? "all passed" : "failing"}
              </span>
            ) : null}
          </div>
          {validate ? (
            <>
              <div className="panel-summary" data-testid="debug-validate-summary">
                {validate.summary}
              </div>
              {validate.failingSummary ? (
                <div className="fail-box" data-testid="debug-validate-failing">
                  {validate.failingSummary}
                </div>
              ) : (
                <div className="sub-empty">No failing tests reported.</div>
              )}
            </>
          ) : (
            <div className="sub-empty">Waiting for validation…</div>
          )}
        </div>
      </div>

      <div className="panel" data-testid="debug-review-panel">
        <div className="panel-head">
          <h3>Reviewers · attempt {iteration + 1}</h3>
          <span className="pill">
            {reviews.length} reviewer{reviews.length === 1 ? "" : "s"}
          </span>
        </div>
        {reviews.length > 0 ? (
          <div className="reviewers">
            {reviews.map((r, i) => (
              <div className="reviewer-card" key={i} data-testid="debug-reviewer-card">
                <div className="reviewer-head">
                  <span className="reviewer-name" data-testid="debug-reviewer-name">
                    {r.reviewer}
                  </span>
                  <span className={"badge " + (r.approved ? "ok" : "err")}>{r.approved ? "approved" : "rejected"}</span>
                </div>
                <div className="reviewer-feedback" data-testid="debug-reviewer-feedback">
                  {r.feedback}
                </div>
                {r.issues.length > 0 ? (
                  <ul className="issues" data-testid="debug-reviewer-issues">
                    {r.issues.map((issue, j) => (
                      <li className={"issue " + issue.severity} key={j}>
                        <strong>[{issue.severity}]</strong> {issue.title}
                        {issue.file ? " · " + issue.file : ""}
                        {issue.description ? " — " + issue.description : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="sub-empty" data-testid="debug-reviewer-issues-empty">
                    No issues raised.
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="sub-empty" data-testid="debug-review-empty">
            Waiting for reviewers on this attempt…
          </div>
        )}
      </div>
    </>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Reproduce and fix the reported bug.");
  const [iteration, setIteration] = useState(0);
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const debugRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? debugRuns[0]?.runId;
  const activeRun = debugRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const eventCount = (stream.events ?? []).length;

  async function refresh() {
    await runsQuery.refetch();
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } });
      setSelectedRunId(run.runId);
      setIteration(0);
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
    <main className="shell" data-testid="debug-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Debug</h1>
          <span className="pill" data-testid="debug-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="debug-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="debug-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="Describe the bug to reproduce and fix…"
          />
          <button className="button" data-testid="debug-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" data-testid="debug-cancel" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <button className="button primary" data-testid="debug-launch" onClick={() => void launch()} disabled={busy}>
            Start Debug
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {activeRunId ? (
            <>
              <div className="bug-card" data-testid="debug-bug-report">
                <h2>Bug report</h2>
                <div className="bug-text">{prompt}</div>
              </div>

              <div className="timeline" data-testid="debug-timeline">
                {Array.from({ length: MAX_ITERATIONS }, (_, i) => i).map((i) => (
                  <button
                    key={i}
                    className={"iter-tab" + (i === iteration ? " active" : "")}
                    data-testid={"debug-iter-" + i}
                    onClick={() => setIteration(i)}
                  >
                    <span className="iter-label">Attempt {i + 1}</span>
                    <span className="iter-dots">
                      <span className="dot pending" title="implement" />
                      <span className="dot pending" title="validate" />
                      <span className="dot pending" title="review" />
                    </span>
                  </button>
                ))}
              </div>

              <IterationPanels runId={activeRunId} iteration={iteration} />

              <div className="status-row" style={{ marginTop: 8, color: "var(--muted)" }}>
                <span>{eventCount} events</span>
                <span>· max {MAX_ITERATIONS} attempts</span>
              </div>
            </>
          ) : (
            <div className="empty" data-testid="debug-empty">
              <div>No debug run yet. Describe the bug above and start a run.</div>
              <button
                className="button primary"
                data-testid="debug-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
              >
                Start Debug
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent debug runs</div>
          {debugRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"debug-run-" + r.runId}
              onClick={() => {
                setSelectedRunId(r.runId);
                setIteration(0);
              }}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {debugRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
