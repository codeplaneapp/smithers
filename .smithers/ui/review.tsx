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

const WORKFLOW_KEY = "review";
const MAX_REVIEWERS = 6;
const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
type Severity = (typeof SEVERITIES)[number];

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ReviewIssue = { severity: Severity; title: string; file: string | null; description: string };
type ReviewRow = {
  index: number;
  reviewer: string;
  approved: boolean;
  feedback: string;
  issues: ReviewIssue[];
};

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

export type VerdictState = "approved" | "blocked" | "pending" | "missing";

// Terminal = a known run status that is not active or suspended. The active set
// is `running` plus every waiting status: the bare `waiting` that the gateway
// stream reducer emits for run.paused frames, and every `waiting-*` state
// (waiting-approval, waiting-event, waiting-timer, and any future waiting-*).
// Matching the `waiting` prefix (no hyphen) covers all of them, which leaves the
// terminal set as finished, failed, cancelled, and continued.
export function isRunTerminal(status: string | undefined | null): boolean {
  return status != null && status !== "running" && !status.startsWith("waiting");
}

// The synthesized moderator verdict is the ONLY source of truth (never inferred
// from panelist consensus). `approved === null` means "no verdict yet": while the
// run is still active that is genuinely PENDING, but once the run is terminal a
// missing verdict means the (continueOnFail) moderator failed/produced nothing.
export function verdictStateFor(approved: boolean | null, runTerminal: boolean): VerdictState {
  if (approved === true) return "approved";
  if (approved === false) return "blocked";
  return runTerminal ? "missing" : "pending";
}

// Copy for the empty issues panel. Only the APPROVED verdict may reassure that
// nothing was flagged; pending/missing/blocked with no visible issues must not
// read as a clean review, since there is no positive synthesized verdict.
export function issuesEmptyMessageFor(args: {
  verdictState: VerdictState;
  allIssuesCount: number;
  reviewsCount: number;
  sevFilter: string;
}): string {
  const { verdictState, allIssuesCount, reviewsCount, sevFilter } = args;
  if (allIssuesCount > 0) return "No " + sevFilter + " issues.";
  if (verdictState === "approved") return "No issues raised — the reviewers found nothing to flag.";
  if (verdictState === "blocked") return "No structured issues listed — see the verdict feedback above.";
  if (verdictState === "pending") return "No issues yet — awaiting the synthesized verdict.";
  if (reviewsCount === 0) return "No review output was produced.";
  return "No structured issues in the panelist output (no synthesized verdict).";
}

function asSeverity(value: unknown): Severity {
  return value === "critical" || value === "major" || value === "minor" || value === "nit" ? value : "nit";
}

function extractReview(index: number, value: unknown): ReviewRow | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  const reviewer = asString(row.reviewer);
  if (reviewer === undefined && typeof row.approved !== "boolean") return null;
  const rawIssues = Array.isArray(row.issues) ? row.issues : [];
  const issues: ReviewIssue[] = rawIssues.filter(isRecord).map((it) => ({
    severity: asSeverity(it.severity),
    title: asString(it.title) ?? "Untitled issue",
    file: asString(it.file) ?? null,
    description: asString(it.description) ?? "",
  }));
  return {
    index,
    reviewer: reviewer ?? "reviewer-" + (index + 1),
    approved: row.approved === true,
    feedback: asString(row.feedback) ?? "",
    issues,
  };
}

type Synthesis = { approved: boolean; feedback: string; issues: ReviewIssue[] };
function extractSynthesis(value: unknown): Synthesis | null {
  const response = isRecord(value) ? value : {};
  const row = isRecord(response.row) ? response.row : isRecord(response) ? response : {};
  if (typeof row.approved !== "boolean" && asString(row.feedback) === undefined) return null;
  const rawIssues = Array.isArray(row.issues) ? row.issues : [];
  const issues: ReviewIssue[] = rawIssues.filter(isRecord).map((it) => ({
    severity: asSeverity(it.severity),
    title: asString(it.title) ?? "Untitled issue",
    file: asString(it.file) ?? null,
    description: asString(it.description) ?? "",
  }));
  return { approved: row.approved === true, feedback: asString(row.feedback) ?? "", issues };
}

function statusClass(status: string | undefined) {
  // "continued" is terminal (the run continued into another record), so it is not
  // styled as active; active/suspended runs (running + waiting*) show the amber
  // running badge.
  if (status === "running" || (status != null && status.startsWith("waiting"))) return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; --crit:#f87171; --major:#fb923c; --minor:#fbbf24; --nit:#8a8a8e; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
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
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".verdict { display:flex; align-items:center; gap:18px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px 22px; margin-bottom:18px; }",
  ".verdict.approved { box-shadow:inset 4px 0 0 var(--ok); }",
  ".verdict.blocked { box-shadow:inset 4px 0 0 var(--err); }",
  ".verdict.pending { box-shadow:inset 4px 0 0 var(--muted); }",
  ".verdict-mark { font-size:34px; line-height:1; }",
  ".verdict.approved .verdict-mark { color:var(--ok); }",
  ".verdict.blocked .verdict-mark { color:var(--err); }",
  ".verdict.pending .verdict-mark { color:var(--muted); }",
  ".verdict-body { flex:1; }",
  ".verdict-headline { font-size:16px; font-weight:600; margin-bottom:4px; }",
  ".verdict-sub { color:var(--muted); font-size:12px; }",
  ".approval-bar { height:8px; border-radius:4px; background:var(--panel); overflow:hidden; margin-top:8px; width:220px; }",
  ".approval-bar > span { display:block; height:100%; background:var(--ok); }",
  ".sev-summary { display:flex; gap:8px; margin-left:auto; }",
  ".section-head { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:22px 0 10px; }",
  ".lanes { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }",
  ".lane { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px; cursor:pointer; }",
  ".lane.approved { box-shadow:inset 3px 0 0 var(--ok); }",
  ".lane.blocked { box-shadow:inset 3px 0 0 var(--err); }",
  ".lane-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }",
  ".lane-name { font-weight:600; }",
  ".lane-feedback { color:var(--muted); font-size:12px; max-height:60px; overflow:hidden; }",
  ".lane.open .lane-feedback { max-height:none; }",
  ".lane-badges { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }",
  ".sev { font-size:10px; font-weight:700; text-transform:uppercase; padding:2px 7px; border-radius:99px; border:1px solid var(--border); }",
  ".sev.critical { color:var(--crit); border-color:var(--crit); }",
  ".sev.major { color:var(--major); border-color:var(--major); }",
  ".sev.minor { color:var(--minor); border-color:var(--minor); }",
  ".sev.nit { color:var(--nit); border-color:var(--nit); }",
  ".sev.active { background:var(--card); }",
  ".filters { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }",
  ".filter-btn { cursor:pointer; }",
  ".issue { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin-bottom:8px; }",
  ".issue-top { display:flex; align-items:center; gap:10px; }",
  ".issue-title { font-weight:600; }",
  ".issue-file { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); }",
  ".issue-desc { color:var(--muted); font-size:12px; margin-top:6px; }",
  ".issue-from { font-size:11px; color:var(--muted); margin-top:6px; }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
  ".empty .button { margin-top:14px; }",
  ".empty .desc { max-width:420px; margin:8px auto 0; font-size:12px; line-height:1.6; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; flex-direction:column; gap:4px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".run-row .row-line { display:flex; justify-content:space-between; gap:8px; align-items:center; }",
  ".run-row .mono { font-family:ui-monospace,monospace; font-size:11px; }",
  ".run-row .approve-count { font-size:11px; color:var(--muted); }",
].join("\n");

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Review the current repository changes.");
  const [busy, setBusy] = useState(false);
  const [openLanes, setOpenLanes] = useState<Record<number, boolean>>({});
  const [sevFilter, setSevFilter] = useState<Severity | "all">("all");

  const runsQuery = useGatewayRuns({ filter: { limit: 20 } });
  const actions = useGatewayActions();

  const reviewRuns = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runIdFromUrl() ?? reviewRuns[0]?.runId;
  // Authoritative run record fetched by id (not limited to the recent-runs list),
  // so a deep ?runId= link or an older run still resolves its real status.
  const activeRunDetail = useGatewayRun(activeRunId);
  const activeRun =
    (activeRunDetail.data as RunSummary | undefined) ?? reviewRuns.find((r) => r.runId === activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const eventCount = (stream.events ?? []).length;

  // Probe a fixed set of panelist reviewer lanes (Panel node ids review-panelist-0 .. review-panelist-N).
  const n0 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-0", iteration: 0 });
  const n1 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-1", iteration: 0 });
  const n2 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-2", iteration: 0 });
  const n3 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-3", iteration: 0 });
  const n4 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-4", iteration: 0 });
  const n5 = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-panelist-5", iteration: 0 });
  const nodeQueries = [n0, n1, n2, n3, n4, n5];
  // The synthesized verdict from the moderator (usually Codex).
  const moderator = useGatewayNodeOutput({ runId: activeRunId, nodeId: "review-moderator", iteration: 0 });
  const synthesis = useMemo(() => extractSynthesis(moderator.data), [moderator.data]);

  const reviews = useMemo(() => {
    const out: ReviewRow[] = [];
    for (let i = 0; i < MAX_REVIEWERS; i++) {
      const parsed = extractReview(i, nodeQueries[i].data);
      if (parsed) out.push(parsed);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n0.data, n1.data, n2.data, n3.data, n4.data, n5.data]);

  const approvedCount = reviews.filter((r) => r.approved).length;
  const runTerminal = isRunTerminal(activeRun?.status);
  const verdictState = verdictStateFor(synthesis ? synthesis.approved : null, runTerminal);
  const verdictApproved = verdictState === "approved";
  // Render the verdict card whenever there is panelist/moderator output OR the run
  // is terminal without a verdict (so the "missing verdict" state is shown instead
  // of the empty "waiting" placeholder).
  const hasContent = reviews.length > 0 || synthesis !== null || verdictState === "missing";
  // Prefer the moderator's consolidated issues once synthesized; the panelist
  // union can differ (the moderator may merge, escalate, or drop issues).
  const allIssues = synthesis
    ? synthesis.issues.map((it) => ({ ...it, reviewer: "synthesized" }))
    : reviews.flatMap((r) => r.issues.map((it) => ({ ...it, reviewer: r.reviewer })));
  const sevCounts = SEVERITIES.reduce((acc, s) => {
    acc[s] = allIssues.filter((it) => it.severity === s).length;
    return acc;
  }, {} as Record<Severity, number>);
  const visibleIssues = sevFilter === "all" ? allIssues : allIssues.filter((it) => it.severity === sevFilter);
  const issuesEmptyMessage = issuesEmptyMessageFor({
    verdictState,
    allIssuesCount: allIssues.length,
    reviewsCount: reviews.length,
    sevFilter,
  });

  async function refresh() {
    await Promise.all([runsQuery.refetch(), activeRunDetail.refetch(), moderator.refetch(), ...nodeQueries.map((q) => q.refetch())]);
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

  return (
    <main className="shell" data-testid="review-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Review</h1>
          <span className="pill" data-testid="review-runid">{activeRunId ? shortRunId(activeRunId) : "No run"}</span>
          {activeRun ? (
            <span className={"badge " + statusClass(activeRun.status)} data-testid="review-status">{activeRun.status ?? "idle"}</span>
          ) : null}
        </div>
        <div className="toolbar">
          <input
            className="prompt"
            data-testid="review-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            placeholder="What should be reviewed?"
          />
          <button className="button" data-testid="review-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {activeRun && !runTerminal ? (
            <button className="button danger" data-testid="review-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" data-testid="review-launch" onClick={() => void launch()} disabled={busy}>Launch Review</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {hasContent ? (
            <>
              <div className={"verdict " + (verdictState === "pending" ? "pending" : verdictState === "approved" ? "approved" : "blocked")} data-testid="review-verdict">
                <span className="verdict-mark">{verdictState === "pending" ? "…" : verdictState === "approved" ? "✓" : "✗"}</span>
                <div className="verdict-body">
                  <div className="verdict-headline">
                    {verdictState === "pending"
                      ? "Awaiting synthesized verdict"
                      : verdictState === "missing"
                        ? "No synthesized verdict — the moderator produced none"
                        : verdictApproved
                          ? "Approved — synthesized verdict"
                          : "Blocked — synthesized verdict"}
                  </div>
                  <div className="verdict-sub">{approvedCount} of {reviews.length} panelists approved{verdictState === "pending" ? " · awaiting moderator synthesis" : verdictState === "missing" ? " · moderator produced no verdict" : " · moderator synthesized"}</div>
                  {synthesis && synthesis.feedback ? (
                    <div className="verdict-sub" data-testid="review-synthesis-feedback" style={{ marginTop: 6, color: "var(--text)" }}>{synthesis.feedback}</div>
                  ) : null}
                  <div className="approval-bar">
                    <span style={{ width: (reviews.length ? (approvedCount / reviews.length) * 100 : 0) + "%" }} />
                  </div>
                </div>
                <div className="sev-summary">
                  {SEVERITIES.map((s) => (
                    <span key={s} className={"sev " + s}>{s} {sevCounts[s]}</span>
                  ))}
                </div>
              </div>

              <div className="section-head">Panelists ({reviews.length})</div>
              <div className="lanes" data-testid="review-reviewers">
                {reviews.map((r) => (
                  <div
                    key={r.index}
                    className={"lane " + (r.approved ? "approved" : "blocked") + (openLanes[r.index] ? " open" : "")}
                    data-testid={"review-reviewer-" + r.index}
                    onClick={() => setOpenLanes((prev) => ({ ...prev, [r.index]: !prev[r.index] }))}
                  >
                    <div className="lane-top">
                      <span className="lane-name">{r.reviewer}</span>
                      <span className={"badge " + (r.approved ? "finished" : "failed")}>{r.approved ? "approved" : "denied"}</span>
                    </div>
                    <div className="lane-feedback">{r.feedback || "No feedback provided."}</div>
                    <div className="lane-badges">
                      {SEVERITIES.map((s) => {
                        const c = r.issues.filter((it) => it.severity === s).length;
                        return c > 0 ? <span key={s} className={"sev " + s}>{s} {c}</span> : null;
                      })}
                      {r.issues.length === 0 ? <span className="sev nit">no issues</span> : null}
                    </div>
                  </div>
                ))}
              </div>

              <div className="section-head">Issues</div>
              <div className="filters">
                <button
                  className={"sev nit filter-btn" + (sevFilter === "all" ? " active" : "")}
                  data-testid="review-filter-all"
                  onClick={() => setSevFilter("all")}
                >
                  all {allIssues.length}
                </button>
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    className={"sev " + s + " filter-btn" + (sevFilter === s ? " active" : "")}
                    data-testid={"review-filter-" + s}
                    onClick={() => setSevFilter(s)}
                  >
                    {s} {sevCounts[s]}
                  </button>
                ))}
              </div>
              <div data-testid="review-issues">
                {visibleIssues.map((it, i) => (
                  <div className="issue" key={i} data-testid="review-issue">
                    <div className="issue-top">
                      <span className={"sev " + it.severity}>{it.severity}</span>
                      <span className="issue-title">{it.title}</span>
                      {it.file ? <span className="issue-file">{it.file}</span> : null}
                    </div>
                    {it.description ? <div className="issue-desc">{it.description}</div> : null}
                    <div className="issue-from">flagged by {it.reviewer}</div>
                  </div>
                ))}
                {visibleIssues.length === 0 ? (
                  <div className="empty" data-testid="review-issues-empty">
                    {issuesEmptyMessage}
                  </div>
                ) : null}
              </div>

              <div className="section-head" style={{ color: "var(--muted)" }}>
                {eventCount} events{nodeQueries.some((q) => q.loading) || moderator.loading ? " · refreshing…" : ""}
              </div>
            </>
          ) : (
            <div className="empty" data-testid="review-empty">
              <div>{activeRunId ? "Waiting for the review panel…" : "No review runs yet."}</div>
              <div className="desc">
                Launch a review to have the code changes examined by a panel of reviewers in parallel, then
                synthesized by a moderator into one verdict. Each panelist reports an approve/deny verdict,
                written feedback, and issues by severity; the verdict above reflects the moderator's synthesis.
              </div>
              <button className="button primary" data-testid="review-launch-empty" onClick={() => void launch()} disabled={busy}>
                Launch Review
              </button>
            </div>
          )}
        </div>

        <aside className="sidebar">
          <div className="side-head">Recent reviews</div>
          {reviewRuns.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              data-testid={"review-run-" + r.runId}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <div className="row-line">
                <span className="mono">{shortRunId(r.runId)}</span>
                <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
              </div>
              {r.runId === activeRunId && reviews.length > 0 ? (
                <span className="approve-count">{approvedCount}/{reviews.length} approved</span>
              ) : null}
            </button>
          ))}
          {reviewRuns.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

// Guard the mount so this module can be imported by unit tests (which exercise
// the exported pure helpers); in the browser `document` is defined and it mounts.
if (typeof document !== "undefined") {
  createGatewayReactRoot(<App />);
}
