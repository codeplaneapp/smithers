/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "research-plan-implement";

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
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 8) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}
function rowOf(value: unknown): Record<string, unknown> {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : {};
  return row;
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

type ReviewIssue = { severity: string; title: string; file: string | null; description: string };
type ReviewOutput = { reviewer: string; approved: boolean; feedback: string; issues: ReviewIssue[] };
function extractReview(value: unknown): ReviewOutput | null {
  const row = rowOf(value);
  const reviewer = asString(row.reviewer);
  const approved = asBool(row.approved);
  if (reviewer === undefined && approved === undefined) return null;
  const rawIssues = Array.isArray(row.issues) ? row.issues : [];
  const issues: ReviewIssue[] = rawIssues
    .filter(isRecord)
    .map((i) => ({
      severity: asString(i.severity) ?? "nit",
      title: asString(i.title) ?? "Issue",
      file: asString(i.file) ?? null,
      description: asString(i.description) ?? "",
    }));
  return {
    reviewer: reviewer ?? "reviewer",
    approved: approved ?? false,
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
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; flex-wrap:wrap; }",
  ".prompt { flex:1; min-width:200px; max-width:420px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".check { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); cursor:pointer; user-select:none; }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.danger { color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:1fr 280px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".badge.ok { color:var(--ok); border-color:var(--ok); }",
  ".badge.err { color:var(--err); border-color:var(--err); }",
  ".badge.warn { color:var(--warn); border-color:var(--warn); }",
  ".badge.tdd { color:var(--primary); border-color:var(--primary); }",
  ".stage { margin-bottom:24px; }",
  ".stage-label { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin:0 0 10px; display:flex; align-items:center; gap:8px; }",
  ".panel { background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:14px; overflow:hidden; }",
  ".panel-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 16px; cursor:pointer; }",
  ".panel-head h2 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".panel-head .left { display:flex; align-items:center; gap:8px; min-width:0; }",
  ".panel-body { padding:0 16px 16px; }",
  ".summary-text { font-size:14px; line-height:1.55; }",
  ".findings { list-style:none; margin:8px 0 0; padding:0; }",
  ".findings li { display:flex; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); }",
  ".findings li:last-child { border-bottom:0; }",
  ".dot { flex:0 0 6px; height:6px; margin-top:7px; border-radius:50%; background:var(--primary); }",
  ".steps { list-style:none; margin:8px 0 0; padding:0; }",
  ".steps li { display:flex; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }",
  ".steps li:last-child { border-bottom:0; }",
  ".step-num { flex:0 0 24px; height:24px; border-radius:50%; background:var(--panel); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--muted); }",
  ".sweep { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }",
  ".kv { display:flex; gap:8px; font-size:12px; color:var(--muted); margin-top:6px; }",
  ".files { list-style:none; margin:8px 0 0; padding:0; }",
  ".files li { font-family:ui-monospace,monospace; font-size:12px; padding:5px 0; border-bottom:1px solid var(--border); }",
  ".files li:last-child { border-bottom:0; }",
  ".reviewer-card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; }",
  ".reviewer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
  ".sev-row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }",
  ".sev { font-size:10px; font-weight:600; text-transform:uppercase; padding:2px 6px; border-radius:4px; border:1px solid var(--border); color:var(--muted); }",
  ".sev.critical { color:var(--err); border-color:var(--err); }",
  ".sev.major { color:var(--warn); border-color:var(--warn); }",
  ".sev.minor { color:var(--primary); border-color:var(--primary); }",
  ".feedback { font-size:12px; color:var(--muted); margin-top:8px; }",
  ".feedback-banner { background:rgba(248,113,113,0.08); border:1px solid var(--err); border-radius:8px; padding:12px 16px; margin-bottom:14px; }",
  ".feedback-banner h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--err); }",
  ".feedback-banner pre { margin:0; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:12px; color:var(--text); }",
  ".gate { display:flex; align-items:center; gap:10px; padding:14px 16px; border:1px solid var(--border); border-radius:10px; background:var(--card); }",
  ".muted { color:var(--muted); }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".launch-form { max-width:520px; margin:48px auto; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:24px; }",
  ".launch-form h2 { margin:0 0 4px; font-size:16px; }",
  ".launch-form p { margin:0 0 18px; color:var(--muted); }",
  ".launch-form .prompt { width:100%; max-width:none; height:36px; margin-bottom:14px; }",
  ".launch-form .row { display:flex; align-items:center; justify-content:space-between; gap:12px; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  "@media (max-width:860px){ .main { grid-template-columns:1fr; } .sidebar { display:none; } .sweep { grid-template-columns:1fr; } }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued") return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function Panel(props: {
  title: string;
  testId: string;
  badge?: { text: string; cls: string } | null;
  pending: boolean;
  pendingText: string;
  children?: any;
}) {
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
      {open ? (
        <div className="panel-body">
          {props.pending ? <div className="muted">{props.pendingText}</div> : props.children}
        </div>
      ) : null}
    </div>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Implement the requested change.");
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

  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const researchOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "research", iteration: 0 });
  const planOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "plan", iteration: 0 });
  const implementOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:implement", iteration: 0 });
  const validateOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:validate", iteration: 0 });
  const reviewOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:review:0", iteration: 0 });

  const research = useMemo(() => extractResearch(researchOut.data), [researchOut.data]);
  const plan = useMemo(() => extractPlan(planOut.data), [planOut.data]);
  const implement = useMemo(() => extractImplement(implementOut.data), [implementOut.data]);
  const validate = useMemo(() => extractValidate(validateOut.data), [validateOut.data]);
  const review = useMemo(() => extractReview(reviewOut.data), [reviewOut.data]);

  const eventCount = (stream.events ?? []).length;
  const running = statusClass(activeRun?.status) === "running";

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      researchOut.refetch(),
      planOut.refetch(),
      implementOut.refetch(),
      validateOut.refetch(),
      reviewOut.refetch(),
    ]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt, tdd } });
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
      await actions.rewindRun({ runId: activeRunId, frameNo: 0, confirm: true });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const validationFailed = validate !== null && validate.allPassed === false;
  const reviewerApproved = review !== null && review.approved === true;
  const blockingFeedback = validationFailed
    ? validate.failingSummary
    : review !== null && review.approved === false
      ? review.feedback
      : null;

  function sevCount(sev: string) {
    return review ? review.issues.filter((i) => i.severity === sev).length : 0;
  }

  return (
    <main className="shell" data-testid="research-plan-implement-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Research → Plan → Implement</h1>
          <span className="pill" data-testid="research-plan-implement-runid">
            {activeRunId ? shortRunId(activeRunId) : "No run"}
          </span>
          {activeRun ? <span className={"badge " + statusClass(activeRun.status)}>{activeRun.status ?? "idle"}</span> : null}
          {tdd ? <span className="badge tdd">TDD</span> : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="research-plan-implement-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should we build?"
          />
          <label className="check">
            <input type="checkbox" checked={tdd} onChange={(e) => setTdd(e.currentTarget.checked)} /> TDD
          </label>
          <button className="button" data-testid="research-plan-implement-refresh" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          {running ? (
            <button className="button danger" data-testid="research-plan-implement-cancel" onClick={() => void cancel()} disabled={busy}>
              Cancel
            </button>
          ) : null}
          {activeRunId && !running ? (
            <button className="button" data-testid="research-plan-implement-rewind" onClick={() => void rewind()} disabled={busy}>
              Rewind
            </button>
          ) : null}
          <button className="button primary" data-testid="research-plan-implement-launch" onClick={() => void launch()} disabled={busy}>
            Launch
          </button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {!activeRunId ? (
            <div className="launch-form" data-testid="research-plan-implement-empty">
              <h2>Launch a workflow</h2>
              <p>Describe the change. Research informs the plan, then an implement → validate → review loop runs until reviewers approve.</p>
              <input
                className="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                placeholder="What should we build?"
              />
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={tdd} onChange={(e) => setTdd(e.currentTarget.checked)} /> Test-driven (write tests first)
                </label>
                <button className="button primary" data-testid="research-plan-implement-launch-empty" onClick={() => void launch()} disabled={busy}>
                  Launch Workflow
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="stage">
                <p className="stage-label">Stage 1 · Research &amp; Plan</p>

                <div data-testid="research-plan-implement-research">
                  <Panel
                    title="Research"
                    testId="research-panel"
                    badge={research ? { text: "ready", cls: "ok" } : null}
                    pending={research === null}
                    pendingText="Gathering context..."
                  >
                    {research ? (
                      <>
                        <div className="summary-text">{research.summary}</div>
                        {research.keyFindings.length > 0 ? (
                          <ul className="findings">
                            {research.keyFindings.map((f, i) => (
                              <li key={i}>
                                <span className="dot" />
                                <span>{f}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="kv">No key findings recorded.</div>
                        )}
                      </>
                    ) : null}
                  </Panel>
                </div>

                <div data-testid="research-plan-implement-plan">
                  <Panel
                    title="Plan"
                    testId="plan-panel"
                    badge={tdd ? { text: "test-first", cls: "tdd" } : plan ? { text: "ready", cls: "ok" } : null}
                    pending={plan === null}
                    pendingText="Creating plan..."
                  >
                    {plan ? (
                      <>
                        <div className="summary-text">{plan.summary}</div>
                        {plan.steps.length > 0 ? (
                          <ol className="steps">
                            {plan.steps.map((s, i) => (
                              <li key={i}>
                                <span className="step-num">{i + 1}</span>
                                <span>{s}</span>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="kv">No steps in this plan.</div>
                        )}
                      </>
                    ) : null}
                  </Panel>
                </div>
              </div>

              <div className="stage">
                <p className="stage-label">
                  Stage 2 · Implementation Loop
                  <span className="badge warn">impl:loop · max 3</span>
                </p>
                {blockingFeedback ? (
                  <div className="feedback-banner" data-testid="research-plan-implement-feedback">
                    <h3>Feedback fed back to implement</h3>
                    <pre>{blockingFeedback}</pre>
                  </div>
                ) : null}
                <div className="sweep">
                  <div data-testid="research-plan-implement-implement">
                    <Panel
                      title="Implement"
                      testId="implement-panel"
                      badge={
                        implement
                          ? implement.allTestsPassing
                            ? { text: "tests pass", cls: "ok" }
                            : { text: "tests fail", cls: "err" }
                          : null
                      }
                      pending={implement === null}
                      pendingText="Implementing..."
                    >
                      {implement ? (
                        <>
                          <div className="summary-text">{implement.summary}</div>
                          {implement.filesChanged.length > 0 ? (
                            <ul className="files">
                              {implement.filesChanged.map((f, i) => (
                                <li key={i}>{f}</li>
                              ))}
                            </ul>
                          ) : (
                            <div className="kv">No files changed yet.</div>
                          )}
                        </>
                      ) : null}
                    </Panel>
                  </div>

                  <div data-testid="research-plan-implement-validate">
                    <Panel
                      title="Validate"
                      testId="validate-panel"
                      badge={
                        validate
                          ? validate.allPassed
                            ? { text: "passed", cls: "ok" }
                            : { text: "failed", cls: "err" }
                          : null
                      }
                      pending={validate === null}
                      pendingText="Validating..."
                    >
                      {validate ? (
                        <>
                          <div className="summary-text">{validate.summary}</div>
                          {validate.failingSummary ? (
                            <div className="feedback">{validate.failingSummary}</div>
                          ) : (
                            <div className="kv">No failures.</div>
                          )}
                        </>
                      ) : null}
                    </Panel>
                  </div>

                  <div data-testid="research-plan-implement-review">
                    <Panel
                      title="Review"
                      testId="review-panel"
                      badge={
                        review
                          ? review.approved
                            ? { text: "approved", cls: "ok" }
                            : { text: "rejected", cls: "err" }
                          : null
                      }
                      pending={review === null}
                      pendingText="Awaiting reviewer..."
                    >
                      {review ? (
                        <div className="reviewer-card">
                          <div className="reviewer-head">
                            <strong>{review.reviewer}</strong>
                            <span className={"badge " + (review.approved ? "ok" : "err")}>
                              {review.approved ? "approved" : "rejected"}
                            </span>
                          </div>
                          {review.feedback ? <div className="feedback">{review.feedback}</div> : null}
                          {review.issues.length > 0 ? (
                            <div className="sev-row">
                              <span className="sev critical">critical {sevCount("critical")}</span>
                              <span className="sev major">major {sevCount("major")}</span>
                              <span className="sev minor">minor {sevCount("minor")}</span>
                              <span className="sev">nit {sevCount("nit")}</span>
                            </div>
                          ) : (
                            <div className="kv">No issues raised.</div>
                          )}
                        </div>
                      ) : null}
                    </Panel>
                  </div>
                </div>
              </div>

              <div className="stage">
                <p className="stage-label">Stage 3 · Completion Gate</p>
                <div className="gate" data-testid="research-plan-implement-gate">
                  {reviewerApproved && validate && validate.allPassed ? (
                    <>
                      <span className="badge ok">complete</span>
                      <span>Validation passed and reviewers approved.</span>
                    </>
                  ) : (
                    <>
                      <span className="badge warn">awaiting reviewer approvals</span>
                      <span className="muted">
                        Multi-reviewer approval is the final gate before completion.
                      </span>
                    </>
                  )}
                  <span className="muted" style={{ marginLeft: "auto" }}>{eventCount} events</span>
                </div>
              </div>
            </>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {runs.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"research-plan-implement-run-" + r.runId}
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
