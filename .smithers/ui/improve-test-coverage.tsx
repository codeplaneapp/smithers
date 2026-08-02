/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smthrs/gateway-react";
import { WorkflowUiStyles } from "smthrs/gateway-ui";
import { sharedDarkThemeCss } from "./shared-theme";

const WORKFLOW_KEY = "improve-test-coverage";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ReviewIssue = { severity?: string; title?: string; file?: string | null; description?: string };

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
function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  if (isRecord(response.row)) return response.row;
  if (isRecord(response)) return response;
  return null;
}

type ImplementOutput = { summary: string; filesChanged: string[]; allTestsPassing?: boolean };
function extractImplement(value: unknown): ImplementOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const filesChanged = Array.isArray(row.filesChanged)
    ? row.filesChanged.filter((f): f is string => typeof f === "string")
    : [];
  return { summary, filesChanged, allTestsPassing: asBool(row.allTestsPassing) };
}

type ValidateOutput = { summary: string; allPassed?: boolean; failingSummary: string | null };
function extractValidate(value: unknown): ValidateOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  return {
    summary,
    allPassed: asBool(row.allPassed),
    failingSummary: asString(row.failingSummary) ?? null,
  };
}

type ReviewOutput = { reviewer?: string; approved?: boolean; feedback?: string; issues: ReviewIssue[] };
function extractReview(value: unknown): ReviewOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  if (row.feedback === undefined && row.approved === undefined && row.reviewer === undefined) return null;
  const issues = Array.isArray(row.issues)
    ? row.issues.filter(isRecord).map((i) => ({
        severity: asString(i.severity),
        title: asString(i.title),
        file: asString(i.file) ?? null,
        description: asString(i.description),
      }))
    : [];
  return {
    reviewer: asString(row.reviewer),
    approved: asBool(row.approved),
    feedback: asString(row.feedback),
    issues,
  };
}

const styles = [
  ...sharedDarkThemeCss,
  ".pill .mono { font-family:ui-monospace,monospace; }",
  ".iter-pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:var(--primary); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--primary); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".timeline { display:flex; align-items:center; gap:0; margin-bottom:20px; overflow-x:auto; padding-bottom:4px; }",
  ".stage { display:flex; align-items:center; gap:8px; flex:0 0 auto; }",
  ".stage-dot { width:26px; height:26px; border-radius:50%; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".stage.done .stage-dot { background:var(--ok); border-color:var(--ok); color:#0c0c0e; }",
  ".stage.active .stage-dot { border-color:var(--primary); color:var(--primary); box-shadow:0 0 0 3px rgba(94,106,210,0.18); }",
  ".stage-label { font-size:12px; color:var(--muted); }",
  ".stage.done .stage-label,.stage.active .stage-label { color:var(--text); }",
  ".stage-line { width:42px; height:1px; background:var(--border); margin:0 6px; }",
  ".stage-line.done { background:var(--ok); }",
  ".panel-grid { display:grid; grid-template-columns:1fr; gap:16px; }",
  "@media (min-width:980px) { .panel-grid.split { grid-template-columns:1fr 1fr; } }",
  ".card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }",
  ".card h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); display:flex; align-items:center; gap:8px; }",
  ".card.full { margin-bottom:16px; }",
  ".summary-text { font-size:14px; line-height:1.55; }",
  ".badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.err { color:var(--err); border-color:var(--err); }",
  ".files { list-style:none; margin:10px 0 0; padding:0; }",
  ".files li { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); font-family:ui-monospace,monospace; font-size:12px; }",
  ".files li:last-child { border-bottom:0; }",
  ".files .file-dot { width:6px; height:6px; border-radius:50%; background:var(--primary); flex:0 0 auto; }",
  ".inline-empty { color:var(--muted); font-size:12px; margin-top:8px; }",
  ".fail-box { margin-top:10px; background:var(--panel); border:1px solid var(--err); border-radius:6px; padding:10px 12px; font-family:ui-monospace,monospace; font-size:12px; color:var(--err); white-space:pre-wrap; }",
  ".reviewer { border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-top:10px; }",
  ".reviewer:first-of-type { margin-top:0; }",
  ".reviewer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }",
  ".reviewer-name { font-weight:600; font-size:13px; }",
  ".issue-row { display:flex; gap:10px; padding:8px 0; border-top:1px solid var(--border); }",
  ".sev { font-size:10px; font-weight:700; text-transform:uppercase; padding:2px 6px; border-radius:4px; flex:0 0 auto; height:fit-content; border:1px solid var(--border); }",
  ".sev.critical { color:var(--err); border-color:var(--err); }",
  ".sev.major { color:var(--warn); border-color:var(--warn); }",
  ".sev.minor { color:var(--primary); border-color:var(--primary); }",
  ".sev.nit { color:var(--muted); }",
  ".issue-body { min-width:0; }",
  ".issue-title { font-weight:600; }",
  ".issue-desc { color:var(--muted); font-size:12px; }",
  ".issue-file { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); }",
  ".empty .button { margin-top:14px; }",
  ".hero { max-width:480px; margin:48px auto; text-align:center; }",
  ".hero h2 { font-size:18px; margin:0 0 8px; color:var(--text); text-transform:none; letter-spacing:0; justify-content:center; }",
  ".hero p { color:var(--muted); margin:0 0 18px; }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".meta-row { display:flex; align-items:center; gap:10px; margin-top:16px; color:var(--muted); font-size:12px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Improve the test coverage for the current repository.");
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const runStatusClass = statusClass(activeRun?.status);

  const stream = useGatewayRunEvents(activeRunId, { afterSeq: undefined });
  const implementOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: "improve-test-coverage:implement",
    iteration: 0,
  });
  const validateOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: "improve-test-coverage:validate",
    iteration: 0,
  });
  const reviewOut = useGatewayNodeOutput({
    runId: activeRunId,
    nodeId: "improve-test-coverage:review:0",
    iteration: 0,
  });

  const implement = useMemo(() => extractImplement(implementOut.data), [implementOut.data]);
  const validate = useMemo(() => extractValidate(validateOut.data), [validateOut.data]);
  const review = useMemo(() => extractReview(reviewOut.data), [reviewOut.data]);
  const eventCount = (stream.events ?? []).length;

  const implementDone = implement !== null;
  const validateDone = validate !== null;
  const reviewDone = review !== null;
  let activeStage: "implement" | "validate" | "review" | "none" = "none";
  if (activeRunId && runStatusClass === "running") {
    if (!implementDone) activeStage = "implement";
    else if (!validateDone) activeStage = "validate";
    else if (!reviewDone) activeStage = "review";
  }

  async function refresh() {
    await Promise.all([runsQuery.refetch(), implementOut.refetch(), validateOut.refetch(), reviewOut.refetch()]);
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

  const hasAnyOutput = implementDone || validateDone || reviewDone;

  function stageEl(key: "implement" | "validate" | "review", label: string, done: boolean) {
    const cls = "stage" + (done ? " done" : "") + (activeStage === key ? " active" : "");
    return (
      <div className={cls} data-testid={"improve-test-coverage-stage-" + key}>
        <span className="stage-dot">{done ? "✓" : ""}</span>
        <span className="stage-label">{label}</span>
      </div>
    );
  }

  return (
    <main className="shell" data-testid="improve-test-coverage-ui">
      <style>{styles}</style>
      <WorkflowUiStyles mode="theme" />
      <header className="topbar">
        <div className="title-group">
          <h1>Improve Test Coverage</h1>
          <span className="pill" data-testid="improve-test-coverage-runid">
            <span className="mono">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          </span>
          {activeRun ? (
            <span className={"badge " + runStatusClass} data-testid="improve-test-coverage-status">
              {activeRun.status ?? "idle"}
            </span>
          ) : null}
          {activeRunId ? (
            <span className="iter-pill" data-testid="improve-test-coverage-iteration">
              {runStatusClass === "finished"
                ? "complete"
                : runStatusClass === "running"
                  ? "running (max 3)"
                  : "iteration / 3"}
            </span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="improve-test-coverage-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What coverage should we improve?"
          />
          <button
            className="button"
            data-testid="improve-test-coverage-refresh"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </button>
          {activeRun && runStatusClass === "running" ? (
            <button
              className="button danger"
              data-testid="improve-test-coverage-cancel"
              onClick={() => void cancel()}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
          {activeRun && (runStatusClass === "finished" || runStatusClass === "failed") ? (
            <button
              className="button"
              data-testid="improve-test-coverage-resume"
              onClick={() => void launch()}
              disabled={busy}
            >
              Retry
            </button>
          ) : null}
          <button
            className="button primary"
            data-testid="improve-test-coverage-launch"
            onClick={() => void launch()}
            disabled={busy}
          >
            Launch
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {activeRunId ? (
            <div className="timeline" data-testid="improve-test-coverage-timeline">
              {stageEl("implement", "Implement", implementDone)}
              <span className={"stage-line" + (implementDone ? " done" : "")} />
              {stageEl("validate", "Validate", validateDone)}
              <span className={"stage-line" + (validateDone ? " done" : "")} />
              {stageEl("review", "Review", reviewDone)}
            </div>
          ) : null}

          {hasAnyOutput ? (
            <>
              <div className="card full" data-testid="improve-test-coverage-implement">
                <h2>
                  Implementation
                  {implement && implement.allTestsPassing !== undefined ? (
                    <span className={"badge " + (implement.allTestsPassing ? "ok" : "err")}>
                      {implement.allTestsPassing ? "Tests passing" : "Tests failing"}
                    </span>
                  ) : null}
                </h2>
                {implement ? (
                  <>
                    <div className="summary-text">{implement.summary}</div>
                    {implement.filesChanged.length > 0 ? (
                      <ul className="files" data-testid="improve-test-coverage-files">
                        {implement.filesChanged.map((f, i) => (
                          <li key={i} data-testid="improve-test-coverage-file">
                            <span className="file-dot" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="inline-empty" data-testid="improve-test-coverage-files-empty">
                        No files changed reported yet.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="inline-empty">Waiting for the implement stage…</div>
                )}
              </div>

              <div className="panel-grid split">
                <div className="card" data-testid="improve-test-coverage-validate">
                  <h2>
                    Validation
                    {validate && validate.allPassed !== undefined ? (
                      <span className={"badge " + (validate.allPassed ? "ok" : "err")}>
                        {validate.allPassed ? "All passed" : "Failed"}
                      </span>
                    ) : null}
                  </h2>
                  {validate ? (
                    <>
                      <div className="summary-text">{validate.summary}</div>
                      {validate.failingSummary ? (
                        <div className="fail-box" data-testid="improve-test-coverage-failing">
                          {validate.failingSummary}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="inline-empty">Waiting for validation…</div>
                  )}
                </div>

                <div className="card" data-testid="improve-test-coverage-review">
                  <h2>Reviewer Issues</h2>
                  {review ? (
                    <div className="reviewer">
                      <div className="reviewer-head">
                        <span className="reviewer-name">{review.reviewer ?? "reviewer-1"}</span>
                        {review.approved !== undefined ? (
                          <span className={"badge " + (review.approved ? "ok" : "err")}>
                            {review.approved ? "Approved" : "Changes requested"}
                          </span>
                        ) : null}
                      </div>
                      {review.feedback ? <div className="summary-text">{review.feedback}</div> : null}
                      {review.issues.length > 0 ? (
                        review.issues.map((issue, i) => (
                          <div className="issue-row" key={i} data-testid="improve-test-coverage-issue">
                            <span className={"sev " + (issue.severity ?? "nit")}>{issue.severity ?? "nit"}</span>
                            <div className="issue-body">
                              <div className="issue-title">{issue.title ?? "Issue"}</div>
                              {issue.description ? <div className="issue-desc">{issue.description}</div> : null}
                              {issue.file ? <div className="issue-file">{issue.file}</div> : null}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="inline-empty" data-testid="improve-test-coverage-issues-empty">
                          No issues raised by this reviewer.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="inline-empty">Waiting for review…</div>
                  )}
                </div>
              </div>

              <div className="meta-row" data-testid="improve-test-coverage-meta">
                <span>{eventCount} events</span>
                {implementOut.loading || validateOut.loading || reviewOut.loading ? <span>· refreshing…</span> : null}
              </div>
            </>
          ) : activeRunId ? (
            <div className="empty" data-testid="improve-test-coverage-waiting">
              <div>Running iteration 1/3 — finding and adding missing tests…</div>
            </div>
          ) : (
            <div className="hero" data-testid="improve-test-coverage-empty">
              <h2>Improve Test Coverage</h2>
              <p>
                Add high-impact missing tests for this repository. Start a run to find the gaps and verify the new tests
                pass.
              </p>
              <button
                className="button primary"
                data-testid="improve-test-coverage-launch-empty"
                onClick={() => void launch()}
                disabled={busy}
              >
                Launch run
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {runs.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"improve-test-coverage-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
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
