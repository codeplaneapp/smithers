/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "implement";

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

function unwrapRow(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value : {};
  const data = isRecord(response.data) ? response.data : response;
  const row = isRecord(data.row) ? data.row : isRecord(data) ? data : null;
  return row;
}

type ImplementOutput = {
  summary: string;
  filesChanged: string[];
  allTestsPassing: boolean | undefined;
};
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

type ValidateOutput = {
  summary: string;
  allPassed: boolean | undefined;
  failingSummary: string | null;
};
function extractValidate(value: unknown): ValidateOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const summary = asString(row.summary);
  if (summary === undefined) return null;
  const failingSummary = asString(row.failingSummary) ?? null;
  return { summary, allPassed: asBool(row.allPassed), failingSummary };
}

type ReviewIssue = { severity: string; title: string; file: string | null; description: string };
type ReviewOutput = {
  reviewer: string;
  approved: boolean | undefined;
  feedback: string;
  issues: ReviewIssue[];
};
function extractReview(value: unknown): ReviewOutput | null {
  const row = unwrapRow(value);
  if (!row) return null;
  const reviewer = asString(row.reviewer);
  const feedback = asString(row.feedback);
  if (reviewer === undefined && feedback === undefined) return null;
  const issues = Array.isArray(row.issues)
    ? row.issues
        .map((raw): ReviewIssue | null => {
          if (!isRecord(raw)) return null;
          const title = asString(raw.title);
          if (title === undefined) return null;
          return {
            severity: asString(raw.severity) ?? "nit",
            title,
            file: asString(raw.file) ?? null,
            description: asString(raw.description) ?? "",
          };
        })
        .filter((i): i is ReviewIssue => i !== null)
    : [];
  return {
    reviewer: reviewer ?? "reviewer",
    approved: asBool(row.approved),
    feedback: feedback ?? "",
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
  ".banner { display:flex; align-items:center; gap:12px; padding:14px 18px; border-radius:10px; margin-bottom:18px; border:1px solid var(--border); font-weight:600; }",
  ".banner.done { background:rgba(74,222,128,0.08); border-color:var(--ok); color:var(--ok); }",
  ".banner.blocked { background:rgba(248,113,113,0.08); border-color:var(--err); color:var(--err); }",
  ".banner.progress { background:rgba(94,106,210,0.1); border-color:var(--primary); color:#aab2f0; }",
  ".banner-icon { font-size:18px; }",
  ".banner-sub { font-weight:400; color:var(--muted); font-size:12px; }",
  ".iteration { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".phase { background:var(--card); border:1px solid var(--border); border-radius:10px; margin-bottom:14px; overflow:hidden; }",
  ".phase-head { display:flex; align-items:center; gap:10px; padding:14px 18px; cursor:pointer; user-select:none; }",
  ".phase-head:hover { background:var(--panel); }",
  ".phase-dot { flex:0 0 10px; width:10px; height:10px; border-radius:50%; background:var(--muted); }",
  ".phase-dot.ok { background:var(--ok); }",
  ".phase-dot.err { background:var(--err); }",
  ".phase-dot.pending { background:var(--border); }",
  ".phase-title { font-weight:600; font-size:13px; }",
  ".phase-meta { margin-left:auto; font-size:11px; color:var(--muted); }",
  ".phase-body { padding:0 18px 16px; }",
  ".phase-empty { color:var(--muted); padding:0 18px 16px; font-size:12px; }",
  ".kv { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin:10px 0 6px; }",
  ".summary-text { font-size:14px; line-height:1.55; }",
  ".chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }",
  ".chip { font-family:ui-monospace,monospace; font-size:11px; background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:3px 8px; }",
  ".reviewers { display:grid; grid-template-columns:1fr 1fr; gap:12px; }",
  ".reviewer-card { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:14px; }",
  ".reviewer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }",
  ".reviewer-name { font-weight:600; font-size:12px; }",
  ".verdict { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".verdict.approved { color:var(--ok); border-color:var(--ok); }",
  ".verdict.rejected { color:var(--err); border-color:var(--err); }",
  ".reviewer-feedback { font-size:12px; color:var(--text); line-height:1.5; }",
  ".issues { list-style:none; margin:10px 0 0; padding:0; }",
  ".issue { display:flex; gap:8px; align-items:flex-start; padding:6px 0; border-top:1px solid var(--border); }",
  ".sev { flex:0 0 auto; font-size:10px; font-weight:700; text-transform:uppercase; padding:2px 6px; border-radius:4px; }",
  ".sev.critical { background:rgba(248,113,113,0.15); color:var(--err); }",
  ".sev.major { background:rgba(251,146,60,0.15); color:#fb923c; }",
  ".sev.minor { background:rgba(251,191,36,0.15); color:var(--warn); }",
  ".sev.nit { background:var(--card); color:var(--muted); }",
  ".issue-body { font-size:12px; }",
  ".issue-title { font-weight:600; }",
  ".issue-file { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); }",
  ".feedback-block { background:#0e0e10; border:1px solid var(--err); border-radius:10px; padding:14px 16px; margin-bottom:14px; }",
  ".feedback-block h2 { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--err); }",
  ".feedback-pre { margin:0; white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; color:#ddd; max-height:260px; overflow:auto; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".empty-lead { max-width:420px; margin:0 auto 8px; }",
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

type PhaseCardProps = {
  testId: string;
  title: string;
  dot: string;
  meta: string;
  children: React.ReactNode;
  emptyText: string;
  hasContent: boolean;
};
function PhaseCard(props: PhaseCardProps) {
  const [open, setOpen] = useState(true);
  return (
    <section className="phase" data-testid={props.testId}>
      <div className="phase-head" onClick={() => setOpen((v) => !v)}>
        <span className={"phase-dot " + props.dot} />
        <span className="phase-title">{props.title}</span>
        <span className="phase-meta">{props.meta}</span>
        <span className="phase-meta">{open ? "collapse" : "expand"}</span>
      </div>
      {open
        ? props.hasContent
          ? <div className="phase-body">{props.children}</div>
          : <div className="phase-empty">{props.emptyText}</div>
        : null}
    </section>
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Implement the requested change.");
  const [busy, setBusy] = useState(false);
  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const implementRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? implementRuns[0]?.runId;
  const activeRun = implementRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });

  const implementOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:implement", iteration: 0 });
  const validateOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:validate", iteration: 0 });
  const review0Out = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:review-panelist-0", iteration: 0 });
  const review1Out = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:review-panelist-1", iteration: 0 });
  const moderatorOut = useGatewayNodeOutput({ runId: activeRunId, nodeId: "impl:review-moderator", iteration: 0 });

  const implement = useMemo(() => extractImplement(implementOut.data), [implementOut.data]);
  const validate = useMemo(() => extractValidate(validateOut.data), [validateOut.data]);
  const review0 = useMemo(() => extractReview(review0Out.data), [review0Out.data]);
  const review1 = useMemo(() => extractReview(review1Out.data), [review1Out.data]);
  const reviews = useMemo(
    () => [review0, review1].filter((r): r is ReviewOutput => r !== null),
    [review0, review1],
  );
  // The synthesized verdict from the review panel's moderator (usually Codex).
  const verdict = useMemo(() => extractReview(moderatorOut.data), [moderatorOut.data]);

  const eventCount = (stream.events ?? []).length;

  const validationPassed = validate !== null && validate.allPassed !== false;
  // Mirror the workflow gate exactly: the synthesized moderator verdict is the
  // source of truth. Until it exists the review is pending (a single approving
  // panelist must NOT flip the run to DONE ahead of the moderator).
  const anyApproved = verdict?.approved === true;
  const reviewRejected = verdict?.approved === false;
  const done = validationPassed && anyApproved;
  const blocked = (validate !== null && validate.allPassed === false) || (!anyApproved && reviewRejected);

  const feedbackParts: string[] = [];
  if (validate && validate.allPassed === false && validate.failingSummary) {
    feedbackParts.push("VALIDATION FAILED:\n" + validate.failingSummary);
  }
  // The synthesized moderator verdict is what gates the loop, so surface its
  // consolidated feedback first (a moderator-only rejection has no panelist row).
  if (verdict && verdict.approved === false && verdict.feedback) {
    feedbackParts.push("SYNTHESIZED REVIEW REJECTED (moderator):\n" + verdict.feedback);
  }
  for (const review of reviews) {
    if (review.approved === false) {
      feedbackParts.push("REVIEWER REJECTED (" + review.reviewer + "):\n" + review.feedback);
      for (const issue of review.issues) {
        feedbackParts.push(
          "  [" + issue.severity + "] " + issue.title + ": " + issue.description + (issue.file ? " (" + issue.file + ")" : ""),
        );
      }
    }
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  const hasAnyOutput = implement !== null || validate !== null || reviews.length > 0 || verdict !== null;

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      implementOut.refetch(),
      validateOut.refetch(),
      review0Out.refetch(),
      review1Out.refetch(),
      moderatorOut.refetch(),
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

  const bannerClass = done ? "done" : blocked ? "blocked" : "progress";
  const bannerIcon = done ? "✓" : blocked ? "✕" : "○";
  const bannerLabel = done ? "DONE" : blocked ? "BLOCKED" : "IN PROGRESS";
  const bannerSub = done
    ? "Validation passed and the synthesized review verdict approved."
    : blocked
      ? "Validation failed or the synthesized review rejected this attempt."
      : "Iterating: implement, validate, then review.";

  const implDot = implement ? (implement.allTestsPassing === false ? "err" : "ok") : "pending";
  const valDot = validate ? (validate.allPassed === false ? "err" : "ok") : "pending";
  const revDot = !verdict ? "pending" : anyApproved ? "ok" : "err";

  return (
    <main className="shell" data-testid="implement-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Implement</h1>
          <span className="pill" data-testid="implement-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="implement-status">{activeRun.status ?? "idle"}</span>
          ) : null}
          <span className="iteration" data-testid="implement-iteration">Loop · up to 3 iterations</span>
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="implement-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should we implement?"
          />
          <button className="button" data-testid="implement-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {activeRun && statusClass(activeRun.status) === "running" ? (
            <button className="button danger" data-testid="implement-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="implement-launch" onClick={() => void launch()} disabled={busy}>Implement</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {hasAnyOutput ? (
            <>
              <div className={"banner " + bannerClass} data-testid="implement-completion">
                <span className="banner-icon">{bannerIcon}</span>
                <span>
                  {bannerLabel}
                  <div className="banner-sub">{bannerSub}</div>
                </span>
              </div>

              <PhaseCard
                testId="implement-phase-implement"
                title="Implementation"
                dot={implDot}
                meta={implement ? (implement.allTestsPassing === false ? "tests failing" : "tests passing") : "pending"}
                emptyText="Waiting for the implement task to produce output."
                hasContent={implement !== null}
              >
                {implement ? (
                  <>
                    <div className="kv">Summary</div>
                    <div className="summary-text">{implement.summary}</div>
                    <div className="kv">Files changed</div>
                    {implement.filesChanged.length > 0 ? (
                      <div className="chips">
                        {implement.filesChanged.map((f, i) => (
                          <span className="chip" key={i}>{f}</span>
                        ))}
                      </div>
                    ) : (
                      <div className="phase-empty" style={{ padding: 0 }}>No files reported as changed.</div>
                    )}
                  </>
                ) : null}
              </PhaseCard>

              <PhaseCard
                testId="implement-phase-validate"
                title="Validation"
                dot={valDot}
                meta={validate ? (validate.allPassed === false ? "fail" : "pass") : "pending"}
                emptyText="Waiting for the validate task to produce output."
                hasContent={validate !== null}
              >
                {validate ? (
                  <>
                    <div className="kv">Summary</div>
                    <div className="summary-text">{validate.summary}</div>
                    {validate.allPassed === false && validate.failingSummary ? (
                      <>
                        <div className="kv">Failing summary</div>
                        <pre className="feedback-pre">{validate.failingSummary}</pre>
                      </>
                    ) : null}
                  </>
                ) : null}
              </PhaseCard>

              <PhaseCard
                testId="implement-phase-review"
                title="Review"
                dot={revDot}
                meta={verdict
                  ? (verdict.approved ? "synthesized: approved" : "synthesized: rejected")
                  : reviews.length > 0 ? reviews.length + " panelist(s)" : "pending"}
                emptyText="Waiting for the review panel to produce verdicts."
                hasContent={reviews.length > 0 || verdict !== null}
              >
                {verdict ? (
                  <div className="reviewer-card" data-testid="implement-synthesis" style={{ marginBottom: 12 }}>
                    <div className="reviewer-head">
                      <span className="reviewer-name">Synthesized verdict (moderator)</span>
                      <span className={"verdict " + (verdict.approved ? "approved" : "rejected")}>
                        {verdict.approved ? "Approved" : "Rejected"}
                      </span>
                    </div>
                    <div className="reviewer-feedback">{verdict.feedback || "No feedback text."}</div>
                  </div>
                ) : null}
                <div className="reviewers">
                  {reviews.map((r, i) => (
                    <div className="reviewer-card" key={i} data-testid={"implement-reviewer-" + i}>
                      <div className="reviewer-head">
                        <span className="reviewer-name">{r.reviewer}</span>
                        <span className={"verdict " + (r.approved ? "approved" : "rejected")}>
                          {r.approved ? "Approved" : "Rejected"}
                        </span>
                      </div>
                      <div className="reviewer-feedback">{r.feedback || "No feedback text."}</div>
                      {r.issues.length > 0 ? (
                        <ul className="issues">
                          {r.issues.map((issue, j) => (
                            <li className="issue" key={j}>
                              <span className={"sev " + issue.severity}>{issue.severity}</span>
                              <span className="issue-body">
                                <span className="issue-title">{issue.title}</span>
                                {issue.file ? <span className="issue-file"> · {issue.file}</span> : null}
                                <div>{issue.description}</div>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="phase-empty" style={{ padding: "8px 0 0" }}>No issues raised.</div>
                      )}
                    </div>
                  ))}
                </div>
              </PhaseCard>

              {feedback ? (
                <div className="feedback-block" data-testid="implement-feedback">
                  <h2>Blocking feedback</h2>
                  <pre className="feedback-pre">{feedback}</pre>
                </div>
              ) : null}

              <div className="status-row" style={{ marginTop: 16, color: "var(--muted)" }}>
                <span>{eventCount} events</span>
                {implementOut.loading || validateOut.loading ? <span>· refreshing…</span> : null}
              </div>
            </>
          ) : (
            <div className="empty" data-testid="implement-empty">
              <div className="empty-lead">
                Implement a code change with automated validation and code review. The workflow will iterate up to 3 times
                if validation or reviews fail, incorporating feedback each round.
              </div>
              <div>{activeRunId ? "Waiting for the first task to run…" : "No run yet."}</div>
              <button className="button primary" data-testid="implement-launch-empty" onClick={() => void launch()} disabled={busy}>
                Implement
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent runs</div>
          {implementRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"implement-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {implementRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
