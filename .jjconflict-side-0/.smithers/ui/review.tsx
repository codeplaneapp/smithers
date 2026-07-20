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
import { NodeOutputView, RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  SectionHeader,
  SmithersUiStyles,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  isTerminalRunStatus,
  normalizeStatus,
} from "smithers-orchestrator/ui";

const WORKFLOW_KEY = "review";
const MAX_REVIEWERS = 6;
const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
type Severity = (typeof SEVERITIES)[number];

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ReviewIssue = { severity: Severity; title: string; file: string | null; description: string };
export type ReviewRow = {
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

// Keep verdict finality on the same normalized terminal vocabulary as every
// status surface; unknown or suspended statuses remain non-terminal.
export function isRunTerminal(status: string | undefined | null): boolean {
  return isTerminalRunStatus(normalizeStatus(status ?? undefined));
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

export function ReviewerLane({
  review,
  open,
  onToggle,
}: {
  review: ReviewRow;
  open: boolean;
  onToggle: () => void;
}) {
  const feedbackId = `review-reviewer-feedback-${review.index}`;
  return (
    <Card
      data-testid={`review-reviewer-${review.index}`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={feedbackId}
      aria-label={`${open ? "Collapse" : "Expand"} review from ${review.reviewer}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggle();
      }}
    >
      <CardHeader>
        <CardTitle>{review.reviewer}</CardTitle>
        <StatusPill
          status={review.approved ? "finished" : "failed"}
          label={review.approved ? "approved" : "denied"}
        />
      </CardHeader>
      <CardContent id={feedbackId}>
        {open ? review.feedback || "No feedback provided." : review.feedback.slice(0, 180) || "No feedback provided."}
        {SEVERITIES.map((severity) => {
          const count = review.issues.filter((issue) => issue.severity === severity).length;
          return count ? (
            <Badge key={severity} variant={severity === "critical" ? "destructive" : "warning"}>
              {severity} {count}
            </Badge>
          ) : null;
        })}
      </CardContent>
    </Card>
  );
}


export function ReviewApp() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Review the current repository changes.");
  const [busy, setBusy] = useState(false);
  const [openLanes, setOpenLanes] = useState<Record<number, boolean>>({});
  const [sevFilter, setSevFilter] = useState<Severity | "all">("all");
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();

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

  return <WorkflowUiShell
    title="Review"
    meta={activeRunId ? shortRunId(activeRunId) : "No run"}
    actions={<>
      {activeRun ? <StatusPill data-testid="review-status" status={activeRun.status ?? "idle"} /> : null}
      <Input data-testid="review-prompt" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="What should be reviewed?" />
      <Button variant="outline" data-testid="review-refresh" onClick={() => void refresh()} disabled={busy}>Refresh</Button>
      {activeRun && !runTerminal ? <Button variant="destructive" data-testid="review-cancel" onClick={() => void cancel()} disabled={busy}>Cancel</Button> : null}
      <Button data-testid="review-launch" onClick={() => void launch()} disabled={busy}>Launch Review</Button>
    </>}
    testId="review-ui"
  >
    <SmithersUiStyles />
    {hasContent ? <>
      <Card data-testid="review-verdict"><CardHeader><CardTitle>{verdictState === "pending" ? "Awaiting synthesized verdict" : verdictState === "missing" ? "No synthesized verdict — the moderator produced none" : verdictApproved ? "Approved — synthesized verdict" : "Blocked — synthesized verdict"}</CardTitle><StatusPill status={verdictState === "approved" ? "finished" : verdictState === "blocked" || verdictState === "missing" ? "failed" : "waiting"} /></CardHeader><CardContent><CardDescription>{approvedCount} of {reviews.length} panelists approved{verdictState === "pending" ? " · awaiting moderator synthesis" : verdictState === "missing" ? " · moderator produced no verdict" : " · moderator synthesized"}</CardDescription>{synthesis?.feedback ? <p data-testid="review-synthesis-feedback">{synthesis.feedback}</p> : null}{SEVERITIES.map((s) => <Badge key={s} variant={s === "critical" ? "destructive" : s === "major" || s === "minor" ? "warning" : "muted"}>{s} {sevCounts[s]}</Badge>)}</CardContent></Card>
      <SectionHeader title={`Panelists (${reviews.length})`} />
      <div data-testid="review-reviewers">{reviews.map((review) => <ReviewerLane key={review.index} review={review} open={openLanes[review.index] ?? false} onToggle={() => setOpenLanes((prev) => ({ ...prev, [review.index]: !prev[review.index] }))} />)}</div>
      <SectionHeader title="Issues" actions={<Tabs value={sevFilter} onValueChange={(value) => setSevFilter(value as Severity | "all")}><TabsList><TabsTrigger value="all" data-testid="review-filter-all" count={allIssues.length}>All</TabsTrigger>{SEVERITIES.map((s) => <TabsTrigger key={s} value={s} data-testid={`review-filter-${s}`} count={sevCounts[s]}>{s}</TabsTrigger>)}</TabsList></Tabs>} />
      <div data-testid="review-issues">{visibleIssues.map((it, i) => <Card key={i} data-testid="review-issue"><CardHeader><CardTitle>{it.title}</CardTitle><Badge variant={it.severity === "critical" ? "destructive" : it.severity === "nit" ? "muted" : "warning"}>{it.severity}</Badge></CardHeader><CardContent><CardDescription>{it.file ? `${it.file} · ` : ""}flagged by {it.reviewer}</CardDescription>{it.description}</CardContent></Card>)}{visibleIssues.length === 0 ? <EmptyState data-testid="review-issues-empty" title={issuesEmptyMessage} /> : null}</div>
    </> : <EmptyState data-testid="review-empty" title={activeRunId ? "Waiting for the review panel…" : "No review runs yet."} description="Launch a review to have code changes examined by panelists and synthesized by a moderator." action={<Button data-testid="review-launch-empty" onClick={() => void launch()} disabled={busy}>Launch Review</Button>} />}
    <SectionHeader title="Run activity" eyebrow={`${eventCount} events${nodeQueries.some((q) => q.loading) || moderator.loading ? " · refreshing…" : ""}`} />
    <Tabs defaultValue="runs"><TabsList><TabsTrigger value="runs" count={reviewRuns.length}>Recent reviews</TabsTrigger><TabsTrigger value="tree">Run tree</TabsTrigger><TabsTrigger value="events" count={eventCount}>Events</TabsTrigger></TabsList><TabsContent value="runs">{reviewRuns.map((r) => <Button key={r.runId} variant={r.runId === activeRunId ? "default" : "ghost"} data-testid={`review-run-${r.runId}`} onClick={() => setSelectedRunId(r.runId)}>{shortRunId(r.runId)} <StatusPill status={r.status} />{r.runId === activeRunId && reviews.length > 0 ? `${approvedCount}/${reviews.length} approved` : ""}</Button>)}{reviewRuns.length === 0 ? <EmptyState title="No runs yet." /> : null}</TabsContent><TabsContent value="tree"><RunTree runId={activeRunId} activeNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} /><NodeOutputView runId={activeRunId} nodeId={selectedNodeId} /></TabsContent><TabsContent value="events"><RunEventLog runId={activeRunId} /></TabsContent></Tabs>
  </WorkflowUiShell>;
}

// Guard the mount so this module can be imported by unit tests (which exercise
// the exported pure helpers); in the browser `document` is defined and it mounts.
// Guarding on document alone is not enough: unit tests that import this
// module's pure helpers may run after another test file installed happy-dom
// (a document with no #root). Only mount when the gateway-served page's real
// root element exists.
if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<ReviewApp />);
}
