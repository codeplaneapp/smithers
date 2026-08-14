/** @jsxImportSource react */
/**
 * The Smithers Monitor — a live web UI over every run in the workspace.
 *
 * Served by the gateway at /monitor (mounted by `smithers gateway`, opened by
 * `smithers monitor`). Purely an observer: it launches nothing, everything on
 * screen is live gateway state. Domain logic lives in ./monitorModel.ts.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayConnectionStatus,
  useGatewayNodeOutput,
  useGatewayRpc,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
  useGatewayRunTree,
  useGatewayRunTokenUsage,
  useGatewayUsageReports,
  useGatewayWorkflows,
  type UseGatewayRunTreeResult,
} from "smthrs/gateway-react";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "smthrs/gateway-client";
import { HijackCandidateButton, OneshotSurface, WorkflowUiStyles } from "smthrs/gateway-ui";
import {
  Button,
  observeReducedMotion,
  prefersReducedMotion,
  SmithersUiStyles,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "smthrs/ui";
import { Chip, MonitorToolbar, RunLifecycleControls, RunRailRow, RunsPagination, ToneDot } from "./monitorShell.tsx";
import { processPatch, type CodeViewItem } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import {
  accountRowsOf,
  asArray,
  asNumber,
  asString,
  autoExpandKeys,
  buildTimeline,
  canRetryTask,
  embedModeFromSearch,
  clampFrameNo,
  connectionViewFor,
  cronRowsOf,
  dataRowsOf,
  describeErrorCounter,
  diagnoseRun,
  diffPatchesOf,
  diffSummaryOf,
  eventViewFor,
  filterRuns,
  formatDiffSummary,
  formatDurationMs,
  formatElapsed,
  formatEventLine,
  formatLatencyMs,
  formatOutputValue,
  formatScore,
  frameScrubBounds,
  groupForStatus,
  groupRuns,
  hasFailedDescendant,
  histogramStats,
  isCancellable,
  isPausable,
  isRecord,
  isResumable,
  isTerminalStatus,
  labelForStatus,
  looksLikeUnifiedDiff,
  metricValue,
  middleTruncate,
  nextCron,
  nodeErrorOf,
  nodeStateRowsOf,
  nodeSummaryEligible,
  nodeTimingsOf,
  nonZeroErrorCounters,
  openTicketCount,
  opsStats,
  paginateRuns,
  parsePrometheusText,
  pick,
  quotaInfoOf,
  rowOf,
  runErrorOf,
  runProgress,
  runsLandingState,
  runUsageChipOf,
  runsViewState,
  RUNS_PAGE_SIZE,
  scoreRowsOf,
  scoresForNode,
  scoresSummary,
  startedByOf,
  scoreTone,
  selectionSinkFor,
  shortRunId,
  sortRunsForTable,
  splitHeartbeatEvents,
  splitPatchText,
  statusOptions,
  sumDiffSummaries,
  taskProgressOf,
  timeAgo,
  toneForStatus,
  treeNodeKey,
  usageShareRows,
  usageWindowRows,
  waitTone,
  workflowOptions,
  type CronRow,
  type NodeStateRow,
  type PromScrape,
  type RunRow,
  type MonitorConnectionStatus,
  type RunsTableSort,
  type ScoreRow,
  type Tone,
  type TreeNodeLike,
  type UsageReportLike,
  type UsageShareRow,
  type UsageWindowRow,
} from "./monitorModel.ts";
import {
  foldTokenUsage,
  formatTokens,
  nodeUsageBreakdown,
  predictRunUsage,
  subtreeTokenTotals,
  tokenBurnBuckets,
  type NodeTiming,
  type TokenBurnBucket,
  type TokenUsageEvent,
  type TreeNode as PredictionTreeNode,
} from "./usagePrediction.ts";

const monitorMode = embedModeFromSearch(typeof location === "undefined" ? "" : location.search);

function emitSelection(runId: string | undefined, nodeId: string | undefined): void {
  const sink = selectionSinkFor(monitorMode, runId, nodeId);
  if (sink.kind === "url") {
    writeUrlSelection(sink.runId, sink.nodeId);
  } else if (sink.kind === "postMessage" && typeof window !== "undefined") {
    window.parent.postMessage(sink.message, sink.targetOrigin);
  }
}

// ---------------------------------------------------------------------------
// One shared 1-second clock. Only the small label components subscribe, so N
// ticking labels cost one timer and finished labels render static text.
// ---------------------------------------------------------------------------

let clockNowMs = Date.now();
const clockSubscribers = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(callback: () => void): () => void {
  clockSubscribers.add(callback);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockNowMs = Date.now();
      for (const subscriber of clockSubscribers) subscriber();
    }, 1000);
  }
  return () => {
    clockSubscribers.delete(callback);
    if (clockSubscribers.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function useNowMs(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNowMs,
    () => clockNowMs,
  );
}

function LiveElapsed({ startMs }: { startMs: number | undefined }) {
  const now = useNowMs();
  return <>{formatElapsed(startMs, now)}</>;
}

function Elapsed({ startMs, endMs }: { startMs: number | undefined; endMs: number | undefined }) {
  if (endMs) return <>{formatElapsed(startMs, endMs)}</>;
  return <LiveElapsed startMs={startMs} />;
}

function Ago({ ms }: { ms: number | undefined }) {
  const now = useNowMs();
  return <>{timeAgo(ms, now)}</>;
}

function Countdown({ untilMs }: { untilMs: number }) {
  const now = useNowMs();
  const remaining = Math.max(0, untilMs - now);
  if (remaining === 0) return <>due now</>;
  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1_000);
  return (
    <>
      in {mins}m {String(secs).padStart(2, "0")}s
    </>
  );
}

function ApprovalWait({ requestedAtMs }: { requestedAtMs: number | undefined }) {
  const now = useNowMs();
  if (!requestedAtMs) return <span className="mon-dim">—</span>;
  const tone = waitTone(now - requestedAtMs);
  return (
    <span className={`mon-wait tone-${tone}`}>
      waiting <LiveElapsed startMs={requestedAtMs} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared atoms.
// ---------------------------------------------------------------------------

/**
 * Arm-then-confirm: the monitor's ONE confirmation idiom for destructive or
 * irreversible actions (deny, cancel, retry). First click arms the control
 * for a few seconds; a second click while armed commits. No window.confirm.
 */
function useArmConfirm(timeoutMs = 4_000): {
  isArmed: (key: string) => boolean;
  /** Returns true when this click confirms (the control was already armed). */
  armOrConfirm: (key: string) => boolean;
} {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  useEffect(() => {
    if (armedKey === null) return;
    const timer = setTimeout(() => setArmedKey(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [armedKey, timeoutMs]);
  return {
    isArmed: (key) => armedKey === key,
    armOrConfirm: (key) => {
      if (armedKey === key) {
        setArmedKey(null);
        return true;
      }
      setArmedKey(key);
      return false;
    },
  };
}

export function StatusTag({
  status,
  label,
  pulse = true,
}: {
  status: string | undefined;
  label?: string;
  pulse?: boolean;
}) {
  const tone = toneForStatus(status);
  return (
    <span className={`mon-pill tone-${tone}`} data-status={labelForStatus(status)}>
      <span className={`mon-dot${pulse && tone === "running" ? " mon-dot-pulse" : ""}`} aria-hidden />
      {label ?? labelForStatus(status)}
    </span>
  );
}

/**
 * Transport truth readout. "Live" only when the gateway link is really
 * streaming; every degraded state gets the same treatment — short label,
 * one-line guidance, and a manual recovery action where auto-retry alone
 * isn't enough. Copy lives in {@link connectionViewFor} so it stays testable.
 */
function ConnectionBadge() {
  const { status } = useGatewayConnectionStatus();
  const view = connectionViewFor(status);
  return (
    <span className={`mon-conn tone-${view.tone}`} data-testid="monitor-conn" data-conn={status}>
      <ToneDot tone={view.tone} pulse={view.pulse} />
      {view.label}
      {view.hint ? (
        <span className="mon-conn-hint" data-testid="monitor-conn-hint">
          {view.hint}
        </span>
      ) : null}
      {view.action ? (
        <button
          type="button"
          className="mon-chip"
          data-testid="monitor-conn-action"
          title="Reload the Monitor page"
          onClick={() => location.reload()}
        >
          {view.action.label}
        </button>
      ) : null}
    </span>
  );
}

function CopyableRunId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      className="mon-runid"
      title="Copy run id"
      onClick={() => {
        void navigator.clipboard?.writeText(runId).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {runId}
      <span className="mon-dim">{copied ? " copied" : ""}</span>
    </button>
  );
}

function writeUrlSelection(runId: string | undefined, nodeId: string | undefined): void {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  const params = new URLSearchParams(location.search);
  if (runId) params.set("runId", runId);
  else params.delete("runId");
  if (nodeId) params.set("nodeId", nodeId);
  else params.delete("nodeId");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

type MonitorKeyboardState = {
  selectedRunId: string | undefined;
  selectedNodeKey: string | undefined;
  sortedTableRuns: RunRow[];
  railOrderRuns: RunRow[];
  cursorRunId: string | undefined;
  selectNode: (node: TreeNode | undefined) => void;
  selectRun: (runId: string | undefined) => void;
};

export function createMonitorKeydownHandler(
  keyState: { current: MonitorKeyboardState },
  setCursorRunId: (runId: string | undefined) => void,
  setRunsPage: (page: number) => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector(".mon-modal-backdrop")) return;
    const state = keyState.current;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing =
      target !== null &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable);
    if (event.key === "Escape") {
      if (typing) {
        target?.blur();
        return;
      }
      if (state.selectedNodeKey) state.selectNode(undefined);
      else if (state.selectedRunId) state.selectRun(undefined);
      return;
    }
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      document.querySelector<HTMLInputElement>(".mon-topbar input")?.focus();
      return;
    }
    if (event.key === "j" || event.key === "k") {
      const delta = event.key === "j" ? 1 : -1;
      if (state.selectedRunId) {
        const index = state.railOrderRuns.findIndex((run) => run.runId === state.selectedRunId);
        const next = state.railOrderRuns[index + delta];
        if (index >= 0 && next) state.selectRun(next.runId);
        return;
      }
      const list = state.sortedTableRuns;
      if (list.length === 0) return;
      const index = list.findIndex((run) => run.runId === state.cursorRunId);
      const nextIndex =
        index < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + delta));
      setCursorRunId(list[nextIndex]!.runId);
      setRunsPage(Math.floor(nextIndex / RUNS_PAGE_SIZE) + 1);
      return;
    }
    if (event.key === "Enter" && !state.selectedRunId && state.cursorRunId) state.selectRun(state.cursorRunId);
  };
}

// ---------------------------------------------------------------------------
// Approvals inbox (all pending gates across every run).
// ---------------------------------------------------------------------------

type ApprovalLike = {
  runId: string;
  nodeId: string;
  iteration?: number;
  workflowKey?: string;
  requestTitle?: string;
  requestSummary?: string;
  requestedAtMs?: number;
};

function approvalKey(approval: ApprovalLike): string {
  return `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
}

/** Submit one approval decision; shared by the inbox and the health strip's inline gates. */
function useApprovalDecide(onResult: (kind: "ok" | "err", text: string) => void) {
  const actions = useGatewayActions();
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const decide = async (approval: ApprovalLike, approved: boolean) => {
    const key = approvalKey(approval);
    setDecidingKey(key);
    try {
      await actions.submitApproval({
        runId: approval.runId,
        nodeId: approval.nodeId,
        iteration: approval.iteration ?? 0,
        approved,
        decision: { approved },
      });
      onResult("ok", `${approved ? "Approved" : "Denied"} ${approval.nodeId} on ${shortRunId(approval.runId)}.`);
    } catch (error) {
      onResult("err", `Approval failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDecidingKey(null);
    }
  };
  return { decide, decidingKey };
}

/**
 * The decision buttons. Approve is the filled primary and fires immediately;
 * Deny is destructive and uses the arm-then-confirm idiom — the question is
 * never separated from its actions by the agent's context essay.
 */
function ApprovalActions({
  approval,
  decide,
  busy,
}: {
  approval: ApprovalLike;
  decide: (approval: ApprovalLike, approved: boolean) => Promise<void>;
  busy: boolean;
}) {
  const arm = useArmConfirm();
  const denyArmed = arm.isArmed(approvalKey(approval));
  return (
    <div className="mon-approval-actions">
      <Button
        variant="default"
        className="mon-btn-approve"
        data-testid="monitor-approval-approve"
        disabled={busy}
        onClick={() => void decide(approval, true)}
      >
        Approve
      </Button>
      <Button
        variant={denyArmed ? "destructive" : "outline"}
        data-testid="monitor-approval-deny"
        disabled={busy}
        title={
          denyArmed ? "Click again to deny — this fails the waiting gate" : "Deny this request (fails the waiting gate)"
        }
        onClick={() => {
          if (arm.armOrConfirm(approvalKey(approval))) void decide(approval, false);
        }}
      >
        {denyArmed ? "Confirm deny?" : "Deny"}
      </Button>
    </div>
  );
}

/**
 * One decision card: question → actions → clamped context. Shared by the
 * run-detail rail inbox and the overview's "Needs you" band, so the decision
 * UX is identical wherever an approval appears.
 */
function ApprovalCard({
  approval,
  busy,
  decide,
  onSelectRun,
}: {
  approval: ApprovalLike;
  busy: boolean;
  decide: (approval: ApprovalLike, approved: boolean) => Promise<void>;
  onSelectRun: (runId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mon-approval">
      <button
        type="button"
        className="mon-approval-main"
        onClick={() => onSelectRun(approval.runId)}
        title={`Open run ${shortRunId(approval.runId)}`}
      >
        <div className="mon-approval-title">{approval.requestTitle ?? approval.nodeId}</div>
        <div className="mon-approval-meta">
          <span className="mon-mono">{approval.workflowKey ?? "workflow"}</span>
          <span className="mon-mono mon-dim">{shortRunId(approval.runId)}</span>
          <ApprovalWait requestedAtMs={approval.requestedAtMs} />
        </div>
      </button>
      <ApprovalActions approval={approval} decide={decide} busy={busy} />
      {approval.requestSummary ? (
        <div className="mon-approval-summary-wrap">
          <div className={`mon-approval-summary${expanded ? " is-expanded" : ""}`}>{approval.requestSummary}</div>
          <button type="button" className="mon-approval-more" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "less" : "more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ApprovalsInbox({
  onSelectRun,
  onResult,
}: {
  onSelectRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const approvalsQuery = useGatewayApprovals();
  const { decide, decidingKey } = useApprovalDecide(onResult);
  const approvals = (approvalsQuery.data ?? []) as ApprovalLike[];
  if (approvals.length === 0) return null;

  return (
    <section className="mon-inbox" data-testid="monitor-approvals">
      <h2 className="mon-kicker">
        Approvals <span className="mon-count">{approvals.length}</span>
      </h2>
      {approvals.map((approval) => (
        <ApprovalCard
          key={approvalKey(approval)}
          approval={approval}
          busy={decidingKey === approvalKey(approval)}
          decide={decide}
          onSelectRun={onSelectRun}
        />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Runs rail.
// ---------------------------------------------------------------------------

function RunListRow({
  run,
  active,
  lastKnown = false,
  onSelect,
}: {
  run: RunRow;
  active: boolean;
  lastKnown?: boolean;
  onSelect: (runId: string) => void;
}) {
  const tone = toneForStatus(run.status);
  const live = tone === "running" || tone === "waiting";
  const startedBy = startedByOf(run);
  const startedLabel = startedBy?.harness
    ? ` · ${startedBy.harness}${startedBy.sessionId ? ` · ${startedBy.sessionId}` : ""}`
    : startedBy?.sessionId
      ? ` · ${startedBy.sessionId}`
      : "";
  return (
    <RunRailRow
      runId={run.runId}
      name={`${run.workflowKey ?? "unknown"}${startedBy?.harness ? ` · ${startedBy.harness}` : ""}${lastKnown ? " · last-known" : ""}`}
      title={`${run.workflowKey ?? "unknown workflow"}${startedLabel}${startedBy?.detected ? " · auto-detected" : ""}`}
      shortId={shortRunId(run.runId)}
      tone={tone}
      pulse={!lastKnown && tone === "running"}
      when={
        lastKnown ? (
          <span>last-known</span>
        ) : live ? (
          <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={undefined} />
        ) : (
          <Ago ms={run.createdAtMs} />
        )
      }
      active={active}
      onSelect={onSelect}
    />
  );
}

function RunsZeroState({
  state,
  testId,
  hero = false,
  totalCount,
  queryError,
  onResetFilters,
  onRetry,
}: {
  state: Exclude<ReturnType<typeof runsViewState>, "ready">;
  testId: string;
  hero?: boolean;
  totalCount: number;
  queryError?: Error;
  onResetFilters?: () => void;
  onRetry?: () => void | Promise<void>;
}) {
  return (
    <div
      className={`mon-empty${hero ? " mon-empty-hero" : ""}`}
      data-testid={testId}
      data-state={state}
      role={state === "error" ? "alert" : undefined}
    >
      {state === "loading" ? (
        <>
          <div>Loading runs…</div>
          {hero ? (
            <div className="mon-dim">
              Live status, execution tree, node outputs, events, and approvals — for every run this gateway owns.
            </div>
          ) : null}
        </>
      ) : state === "error" ? (
        <>
          <div>Couldn&apos;t load runs.</div>
          <div className="mon-dim">{queryError?.message || "Refresh to try the query again."}</div>
          {onRetry ? (
            <Button variant="outline" data-testid={`${testId}-retry`} onClick={() => void onRetry()}>
              Retry
            </Button>
          ) : null}
        </>
      ) : state === "filtered" ? (
        <>
          <div>No runs match your filters.</div>
          <div className="mon-dim">
            Clear filters to show all {totalCount} {totalCount === 1 ? "run" : "runs"}.
          </div>
          {onResetFilters ? (
            <Button variant="outline" data-testid={`${testId}-reset`} onClick={onResetFilters}>
              Clear filters
            </Button>
          ) : null}
        </>
      ) : (
        <>
          <div>No runs yet.</div>
          <div className="mon-dim">
            Launch one with <code>smithers up &lt;workflow&gt;</code> or <code>smithers workflow run &lt;id&gt;</code>.
          </div>
        </>
      )}
    </div>
  );
}

export function RunsRail({
  runs,
  loading,
  totalCount = runs.length,
  queryError,
  onResetFilters,
  onRetry,
  connStatus,
  selectedRunId,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  totalCount?: number;
  queryError?: Error;
  onResetFilters?: () => void;
  onRetry?: () => void | Promise<void>;
  connStatus: MonitorConnectionStatus;
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}) {
  const groups = groupRuns(runs);
  // Offline and unauthorized carry state-specific banners (an auth failure
  // must never read like a network outage); connecting states just load.
  const connection = connectionViewFor(connStatus);
  const banner = connection.banner;
  const lastKnown = connStatus === "offline" && runs.length > 0;
  const blocked = connStatus === "unauthorized";
  const zeroState = runsViewState({
    visibleCount: runs.length,
    totalCount,
    loading,
    queryError: queryError !== undefined,
  });
  return (
    <nav className="mon-rail-runs" data-testid="monitor-runs">
      {banner ? (
        <div className="mon-banner tone-failed" data-testid={`monitor-runs-${connStatus}`}>
          <div>{banner.title}</div>
          {/* With cached rows below, the banner must say they are last-known
              rather than reuse the no-data copy — the rows are still on screen. */}
          <div className="mon-dim">{lastKnown && connection.hint ? connection.hint : banner.detail}</div>
        </div>
      ) : null}
      {!banner && zeroState !== "ready" ? (
        <RunsZeroState
          state={zeroState}
          testId="monitor-empty"
          totalCount={totalCount}
          queryError={queryError}
          onResetFilters={onResetFilters}
          onRetry={onRetry}
        />
      ) : null}
      {queryError && zeroState === "ready" && !banner ? (
        <div className="mon-banner tone-failed" data-testid="monitor-runs-query-error" role="alert">
          <div>Couldn&apos;t refresh runs.</div>
          <div className="mon-dim">{queryError.message}</div>
          {onRetry ? (
            <Button variant="outline" data-testid="monitor-runs-query-error-retry" onClick={() => void onRetry()}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {!blocked &&
        groups.map((group) => (
          <section key={group.group} className="mon-run-group">
            <h2 className="mon-kicker">
              {group.title}
              {lastKnown ? " · last-known" : ""} <span className="mon-count">{group.runs.length}</span>
            </h2>
            {group.runs.map((run) => (
              <RunListRow
                key={run.runId}
                run={run}
                active={run.runId === selectedRunId}
                lastKnown={lastKnown}
                onSelect={onSelect}
              />
            ))}
          </section>
        ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Small polling data hooks for the gateway's simple-read REST routes and the
// Prometheus /metrics text. Each keeps the last good payload on transient
// fetch failures (the readouts must not blank during a gateway hiccup) but
// reports `failed` so surfaces can say so.
// ---------------------------------------------------------------------------

function useJsonApi(url: string | null, refreshMs: number | null): { body: unknown; loaded: boolean; failed: boolean } {
  const [state, setState] = useState<{ body: unknown; loaded: boolean; failed: boolean }>({
    body: null,
    loaded: false,
    failed: false,
  });
  // Only a URL change resets the data — a polling-cadence flip (a run going
  // live→settled) must not blank an already-loaded panel.
  const lastUrl = useRef(url);
  useEffect(() => {
    if (lastUrl.current !== url) {
      lastUrl.current = url;
      setState({ body: null, loaded: false, failed: false });
    }
    if (!url) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url} ${response.status}`);
        const body: unknown = await response.json();
        if (!cancelled) setState({ body, loaded: true, failed: false });
      } catch {
        if (!cancelled) setState((prev) => ({ body: prev.body, loaded: prev.loaded, failed: true }));
      }
    };
    void load();
    const timer = refreshMs !== null ? setInterval(() => void load(), refreshMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [url, refreshMs]);
  return state;
}

const METRICS_REFRESH_MS = 10_000;

function useMetricsScrape(enabled: boolean): {
  scrape: PromScrape | null;
  failed: boolean;
  scrapedAtMs: number | null;
} {
  const [state, setState] = useState<{ scrape: PromScrape | null; failed: boolean; scrapedAtMs: number | null }>({
    scrape: null,
    failed: false,
    scrapedAtMs: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/metrics");
        if (!response.ok) throw new Error(`metrics ${response.status}`);
        const text = await response.text();
        if (!cancelled) setState({ scrape: parsePrometheusText(text), failed: false, scrapedAtMs: Date.now() });
      } catch {
        if (!cancelled) setState((prev) => ({ scrape: prev.scrape, failed: true, scrapedAtMs: prev.scrapedAtMs }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), METRICS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return state;
}

// ---------------------------------------------------------------------------
// Workspace overview: the ops strip (one quiet row of stat cards above the
// runs table) and the crons panel below it. Numbers first, labels small and
// dim; every value is real gateway state or an honest placeholder.
// ---------------------------------------------------------------------------

export function StatCard({
  value,
  label,
  sub,
  tone,
  testId,
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: Tone;
  testId?: string;
}) {
  return (
    <div className={`mon-stat${tone ? ` tone-${tone}` : ""}`} data-testid={testId ?? "monitor-stat"}>
      <div className="mon-stat-value" title={value}>
        {value}
      </div>
      <div className="mon-stat-label" title={label}>
        {label}
      </div>
      {sub ? (
        <div className="mon-stat-sub mon-dim" title={sub}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/** How far back a failure still counts as "needs you" — older failures are history. */
const FAILURE_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Per-section row cap in the "Needs you" band; the rest collapses to "+N more". */
const NEEDS_YOU_ROW_CAP = 6;

function NeedsYouRunRow({ run, onSelectRun }: { run: RunRow; onSelectRun: (runId: string) => void }) {
  return (
    <button type="button" className="mon-needs-row" onClick={() => onSelectRun(run.runId)}>
      <StatusTag status={run.status} />
      <span className="mon-needs-name">{middleTruncate(run.workflowKey ?? "unknown", 56)}</span>
      <span className="mon-mono mon-dim">{shortRunId(run.runId)}</span>
      <span className="mon-dim mon-needs-when">
        {groupForStatus(run.status) === "failed" ? (
          <Ago ms={run.finishedAtMs ?? run.createdAtMs} />
        ) : (
          <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={undefined} />
        )}
      </span>
    </button>
  );
}

/**
 * The home page's single attention surface: pending approvals (with inline
 * decisions), runs parked waiting on a human, and failures recent enough to
 * still be actionable. Empty = one green all-clear line, and everything else
 * on the page is calm history.
 */
function NeedsYouBand({
  runs,
  loading,
  onSelectRun,
  onResult,
}: {
  runs: RunRow[];
  loading: boolean;
  onSelectRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const now = useNowMs();
  const approvalsQuery = useGatewayApprovals();
  const { decide, decidingKey } = useApprovalDecide(onResult);
  const cronsApi = useJsonApi("/v1/api/crons", 30_000);
  const approvals = (approvalsQuery.data ?? []) as ApprovalLike[];
  const groups = useMemo(() => groupRuns(runs), [runs]);
  const attention = groups.find((group) => group.group === "attention")?.runs ?? [];
  const active = groups.find((group) => group.group === "active")?.runs ?? [];
  // A failed run needs attention while it is fresh; two-week-old corpses in a
  // permanent red band train operators to ignore it (alarm fatigue by design).
  const recentFailures = useMemo(
    () =>
      (groups.find((group) => group.group === "failed")?.runs ?? []).filter(
        (run) => (run.finishedAtMs ?? run.createdAtMs ?? 0) >= now - FAILURE_ATTENTION_WINDOW_MS,
      ),
    [groups, now],
  );
  // Approval-parked runs already render as approval cards — listing the same
  // run again as an attention row would double-count one decision.
  const approvalRunIds = new Set(approvals.map((approval) => approval.runId));
  const parked = attention.filter((run) => !approvalRunIds.has(run.runId));
  const needsCount = approvals.length + parked.length + recentFailures.length;

  if (loading && runs.length === 0) return null;
  if (needsCount === 0) {
    const upcoming = nextCron(cronRowsOf(cronsApi.body));
    const cronNote =
      upcoming?.nextRunAtMs !== undefined
        ? now >= upcoming.nextRunAtMs
          ? " · next cron due now"
          : ` · next cron in ${Math.max(1, Math.round((upcoming.nextRunAtMs - now) / 60_000))}m`
        : "";
    return (
      <div className="mon-needs mon-needs-clear" data-testid="monitor-needs-you">
        <ToneDot tone="ok" />
        All clear — {active.length} running{cronNote}
      </div>
    );
  }
  return (
    <section className="mon-needs mon-inbox" data-testid="monitor-needs-you">
      <h2 className="mon-kicker">
        Needs you <span className="mon-count">{needsCount}</span>
      </h2>
      {approvals.map((approval) => (
        <ApprovalCard
          key={approvalKey(approval)}
          approval={approval}
          busy={decidingKey === approvalKey(approval)}
          decide={decide}
          onSelectRun={onSelectRun}
        />
      ))}
      {parked.slice(0, NEEDS_YOU_ROW_CAP).map((run) => (
        <NeedsYouRunRow key={run.runId} run={run} onSelectRun={onSelectRun} />
      ))}
      {parked.length > NEEDS_YOU_ROW_CAP ? (
        <div className="mon-dim mon-needs-more">
          +{parked.length - NEEDS_YOU_ROW_CAP} more waiting — see the table below
        </div>
      ) : null}
      {recentFailures.slice(0, NEEDS_YOU_ROW_CAP).map((run) => (
        <NeedsYouRunRow key={run.runId} run={run} onSelectRun={onSelectRun} />
      ))}
      {recentFailures.length > NEEDS_YOU_ROW_CAP ? (
        <div className="mon-dim mon-needs-more">
          +{recentFailures.length - NEEDS_YOU_ROW_CAP} more failed in the last 24h — filter the table on failed
        </div>
      ) : null}
    </section>
  );
}

/** One rich row per live run: pulse, name, progress, elapsed — click opens it. */
function ActiveNowBand({ runs, onSelectRun }: { runs: RunRow[]; onSelectRun: (runId: string) => void }) {
  const active = useMemo(() => groupRuns(runs).find((group) => group.group === "active")?.runs ?? [], [runs]);
  if (active.length === 0) return null;
  return (
    <section className="mon-panel mon-active-band" data-testid="monitor-active-now">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Active now <span className="mon-count">{active.length}</span>
        </h2>
      </header>
      {active.map((run) => (
        <button type="button" className="mon-active-row" key={run.runId} onClick={() => onSelectRun(run.runId)}>
          <ToneDot tone={toneForStatus(run.status)} pulse={toneForStatus(run.status) === "running"} />
          <span className="mon-active-name">{middleTruncate(run.workflowKey ?? "unknown", 56)}</span>
          <span className="mon-mono mon-dim">{shortRunId(run.runId)}</span>
          <span className="mon-active-progress">
            <RunProgressCell run={run} />
          </span>
          <span className="mon-mono mon-dim mon-active-elapsed">
            <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={undefined} />
          </span>
        </button>
      ))}
    </section>
  );
}

/**
 * The ops facts that used to be a wall of stat tiles, demoted to one quiet
 * line: still one glance away, no longer competing with the triage band.
 * Latency percentiles live in the Metrics view they came from.
 */
function OpsFooter({ runs, onShowMetrics }: { runs: RunRow[]; onShowMetrics: () => void }) {
  const now = useNowMs();
  const cronsApi = useJsonApi("/v1/api/crons", 30_000);
  const accountsApi = useJsonApi("/v1/api/accounts", 60_000);
  const memoryApi = useJsonApi("/v1/api/memory-facts", 60_000);
  const ticketsApi = useJsonApi("/v1/api/tickets", 60_000);
  const stats = useMemo(() => opsStats(runs as Array<Record<string, unknown>>, now), [runs, now]);
  const accounts = useMemo(() => accountRowsOf(accountsApi.body), [accountsApi.body]);
  const upcoming = nextCron(useMemo(() => cronRowsOf(cronsApi.body), [cronsApi.body]));
  const accountsReady = accounts.filter((account) => account.ready).length;
  const memoryCount = memoryApi.loaded ? dataRowsOf(memoryApi.body).length : undefined;
  const ticketsOpen = ticketsApi.loaded ? openTicketCount(ticketsApi.body) : undefined;
  const parts: Array<{ key: string; text: string; tone?: Tone }> = [
    { key: "engines", text: `${stats.enginesLive} engine${stats.enginesLive === 1 ? "" : "s"} live` },
    {
      key: "completed",
      text: `${stats.completedToday} completed today${stats.failedToday > 0 ? ` · ${stats.failedToday} failed` : ""}`,
      tone: stats.failedToday > 0 ? "failed" : undefined,
    },
  ];
  if (accountsApi.loaded && accounts.length > 0) {
    parts.push({
      key: "accounts",
      text: `accounts ${accountsReady}/${accounts.length}`,
      tone: accountsReady < accounts.length ? "waiting" : undefined,
    });
  }
  if (upcoming) {
    parts.push({
      key: "cron",
      text:
        upcoming.nextRunAtMs !== undefined && now < upcoming.nextRunAtMs
          ? `next cron in ${Math.max(1, Math.round((upcoming.nextRunAtMs - now) / 60_000))}m · ${upcoming.workflow}`
          : `next cron due now · ${upcoming.workflow}`,
    });
  }
  if (memoryCount !== undefined) parts.push({ key: "memory", text: `${memoryCount} memory facts` });
  if (ticketsOpen !== undefined) parts.push({ key: "tickets", text: `${ticketsOpen} open tickets` });
  return (
    <footer className="mon-ops-footer mon-dim" data-testid="monitor-ops-footer">
      {parts.map((part) => (
        <span key={part.key} className={part.tone ? `tone-${part.tone} mon-ops-footer-item` : "mon-ops-footer-item"}>
          {part.text}
        </span>
      ))}
      <button type="button" className="mon-ops-footer-link" onClick={onShowMetrics}>
        Metrics
      </button>
    </footer>
  );
}

function CronsPanel() {
  const now = useNowMs();
  const cronsApi = useJsonApi("/v1/api/crons", 30_000);
  const crons = useMemo(() => cronRowsOf(cronsApi.body), [cronsApi.body]);
  return (
    <section className="mon-panel mon-crons-panel" data-testid="monitor-crons">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Crons <span className="mon-count">{cronsApi.loaded ? crons.length : ""}</span>
        </h2>
      </header>
      {!cronsApi.loaded ? (
        <div className="mon-empty mon-dim">
          {cronsApi.failed ? (
            "Could not load crons — the gateway did not answer."
          ) : (
            <span className="mon-live-pending">
              <span className="mon-dot mon-dot-pulse" aria-hidden /> loading crons…
            </span>
          )}
        </div>
      ) : crons.length === 0 ? (
        <div className="mon-empty mon-dim">
          No crons registered. Add one with <code>smithers cron add &lt;pattern&gt; &lt;workflow&gt;</code>.
        </div>
      ) : (
        <div className="mon-crons-scroll">
          <Table className="mon-runs-table mon-crons-table">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Pattern</TableHead>
                <TableHead scope="col">Workflow</TableHead>
                <TableHead scope="col">Enabled</TableHead>
                <TableHead scope="col">Last run</TableHead>
                <TableHead scope="col">Next run</TableHead>
                <TableHead scope="col">Last error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crons.map((cron) => (
                <TableRow key={cron.cronId} data-cron-id={cron.cronId}>
                  <TableCell className="mon-mono">{cron.pattern}</TableCell>
                  <TableCell className="mon-table-workflow" title={cron.workflowPath ?? cron.workflow}>
                    {cron.workflow}
                  </TableCell>
                  <TableCell>
                    <span className={`mon-pill tone-${cron.enabled ? "ok" : "idle"}`}>
                      <span className="mon-dot" aria-hidden />
                      {cron.enabled ? "enabled" : "disabled"}
                    </span>
                  </TableCell>
                  <TableCell className="mon-dim">
                    <Ago ms={cron.lastRunAtMs} />
                  </TableCell>
                  <TableCell className="mon-mono">
                    {cron.nextRunAtMs === undefined ? (
                      <span className="mon-dim">—</span>
                    ) : now >= cron.nextRunAtMs ? (
                      "due now"
                    ) : (
                      <Countdown untilMs={cron.nextRunAtMs} />
                    )}
                  </TableCell>
                  <TableCell className={cron.error ? "tone-failed mon-cron-error" : "mon-dim"} title={cron.error}>
                    {cron.error ? cron.error.slice(0, 80) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Scores. Scorer results are per-run rows in [0,1] (see scoreRowsOf); the run
// panel collapses to a one-line summary past a handful, and the whole panel
// hides when the run simply has no scores — most runs don't, and an empty
// panel would be noise. The node inspector shows the same rows as chips.
// ---------------------------------------------------------------------------

const SCORES_COLLAPSE_THRESHOLD = 5;

type RunScores = { rows: ScoreRow[]; loaded: boolean };

function useRunScores(runId: string | undefined, live: boolean): RunScores {
  const api = useJsonApi(runId ? `/v1/api/scores?runId=${encodeURIComponent(runId)}` : null, live ? 15_000 : null);
  const rows = useMemo(() => scoreRowsOf(api.body), [api.body]);
  return { rows, loaded: api.loaded };
}

function ScoreRowLine({ row }: { row: ScoreRow }) {
  return (
    <div className="mon-score-row" data-testid="monitor-score-row">
      <span className={`mon-pill tone-${scoreTone(row.score)} mon-score-pill`}>
        <span className="mon-dot" aria-hidden />
        {formatScore(row.score)}
      </span>
      <span className="mon-score-name">{row.scorerName}</span>
      <span className="mon-mono mon-dim mon-score-node" title={row.nodeId}>
        {row.nodeId}
        {row.iteration > 0 ? `#${row.iteration}` : ""}
      </span>
      {row.reason ? (
        <span className="mon-dim mon-score-reason" title={row.reason}>
          {row.reason}
        </span>
      ) : null}
    </div>
  );
}

function ScoresPanel({ scores: { rows, loaded } }: { scores: RunScores }) {
  // No scores → no panel. Most runs never run a scorer; an empty-state panel
  // on every run detail would be pure noise.
  if (!loaded || rows.length === 0) return null;
  const summary = scoresSummary(rows);
  const list = (
    <div className="mon-scores-list">
      {rows.map((row) => (
        <ScoreRowLine key={`${row.nodeId}#${row.iteration}:${row.scorerId}:${row.attempt}`} row={row} />
      ))}
    </div>
  );
  return (
    <section className="mon-panel mon-scores-panel" data-testid="monitor-scores">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Scores <span className="mon-count">{summary.count}</span>
        </h2>
        <span className="mon-dim mon-mono">avg {formatScore(summary.avg)}</span>
      </header>
      {rows.length > SCORES_COLLAPSE_THRESHOLD ? (
        <details className="mon-scores-details">
          <summary className="mon-scores-summary" data-testid="monitor-scores-summary">
            <span className="mon-diff-caret" aria-hidden>
              ▸
            </span>
            {summary.count} scores · avg {formatScore(summary.avg)}
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
    </section>
  );
}

/** Score chips under the inspector's What-happened section — only when this node was scored. */
function NodeScoreChips({ nodeId, scores: { rows, loaded } }: { nodeId: string; scores: RunScores }) {
  const nodeScores = useMemo(() => scoresForNode(rows, nodeId), [rows, nodeId]);
  if (!loaded || nodeScores.length === 0) return null;
  return (
    <div className="mon-node-scores" data-testid="monitor-node-scores">
      {nodeScores.map((row) => (
        <span
          key={`${row.scorerId}:${row.iteration}:${row.attempt}`}
          className={`mon-chip mon-score-chip tone-${scoreTone(row.score)}`}
          title={row.reason ?? row.scorerName}
        >
          {row.scorerName} {formatScore(row.score)}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics view: glanceable operator stats parsed from ONE Prometheus scrape
// (10s refresh) — agent latency percentiles per engine·model, run/RPC/
// connection counters, and any non-zero error counters. Text and the shared
// tone system; monospace numbers; no charting stack.
// ---------------------------------------------------------------------------

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="mon-metric-row">
      <span className={`mon-metric-label${tone ? ` tone-${tone}` : ""}`}>{label}</span>
      <span className={`mon-mono mon-metric-value${tone ? ` tone-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

function MetricsPanel() {
  const now = useNowMs();
  const { scrape, failed, scrapedAtMs } = useMetricsScrape(true);
  const agentLatency = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_agent_duration_ms", ["engine", "model"]) : []),
    [scrape],
  );
  const rpcStats = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_gateway_rpc_duration_ms", ["method"]) : []),
    [scrape],
  );
  const rpcOverall = useMemo(
    () => (scrape ? histogramStats(scrape, "smithers_gateway_rpc_duration_ms", []) : []),
    [scrape],
  );
  const errors = useMemo(() => (scrape ? nonZeroErrorCounters(scrape) : []), [scrape]);
  if (!scrape) {
    return (
      <section className="mon-panel mon-metrics-panel" data-testid="monitor-metrics">
        <header className="mon-panel-head">
          <h2 className="mon-kicker">Metrics</h2>
        </header>
        <div className="mon-empty mon-dim">
          {failed ? (
            "Could not scrape /metrics — the gateway did not answer."
          ) : (
            <span className="mon-live-pending">
              <span className="mon-dot mon-dot-pulse" aria-hidden /> scraping /metrics…
            </span>
          )}
        </div>
      </section>
    );
  }
  const num = (value: number | undefined): string => (value === undefined ? "—" : String(Math.round(value)));
  const uptime = metricValue(scrape, "smithers_process_uptime_seconds");
  return (
    <section className="mon-panel mon-metrics-panel" data-testid="monitor-metrics">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Metrics</h2>
        {failed ? <span className="mon-conn tone-failed">scrape failing — showing last data</span> : null}
        <span className="mon-dim mon-count-note">
          {scrapedAtMs ? `scraped ${Math.max(0, Math.round((now - scrapedAtMs) / 1000))}s ago` : ""}
          {uptime !== undefined ? ` · gateway up ${formatElapsed(now - uptime * 1000, now)}` : ""}
        </span>
      </header>

      <div className="mon-metrics-grid">
        <div className="mon-metrics-section" data-testid="monitor-metrics-agents">
          <h3 className="mon-kicker">Agent latency (this gateway process)</h3>
          {agentLatency.length === 0 ? (
            <div className="mon-empty mon-dim">
              No agent invocations recorded by this gateway process yet — engines attached elsewhere (e.g. `smithers up`
              in a terminal) report to their own process.
            </div>
          ) : (
            <div className="mon-metrics-table">
              <div className="mon-metric-row mon-metric-head">
                <span className="mon-metric-label">engine · model</span>
                <span className="mon-mono mon-metric-value">n · p50 · p95</span>
              </div>
              {agentLatency.map((stat) => (
                <MetricRow
                  key={stat.key}
                  label={stat.key || "(unlabeled)"}
                  value={`${stat.count} · ${formatLatencyMs(stat.p50)} · ${formatLatencyMs(stat.p95)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-runs">
          <h3 className="mon-kicker">Runs & connections</h3>
          <div className="mon-metrics-table">
            <MetricRow
              label="runs started (this process)"
              value={num(metricValue(scrape, "smithers_gateway_runs_started_total"))}
            />
            <MetricRow
              label="runs completed"
              value={num(metricValue(scrape, "smithers_gateway_runs_completed_total"))}
            />
            <MetricRow
              label="connections active"
              value={num(metricValue(scrape, "smithers_gateway_connections_active"))}
            />
            <MetricRow
              label="connections opened"
              value={num(metricValue(scrape, "smithers_gateway_connections_total"))}
            />
            <MetricRow label="pending approvals" value={num(metricValue(scrape, "smithers_approval_pending"))} />
          </div>
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-rpc">
          <h3 className="mon-kicker">
            Gateway RPC{" "}
            {rpcOverall[0] ? (
              <span className="mon-dim">
                — p95 {formatLatencyMs(rpcOverall[0].p95)} over {rpcOverall[0].count} calls
              </span>
            ) : null}
          </h3>
          {rpcStats.length === 0 ? (
            <div className="mon-empty mon-dim">No RPC calls recorded yet.</div>
          ) : (
            <div className="mon-metrics-table">
              <div className="mon-metric-row mon-metric-head">
                <span className="mon-metric-label">method</span>
                <span className="mon-mono mon-metric-value">n · p50 · p95</span>
              </div>
              {rpcStats.slice(0, 10).map((stat) => (
                <MetricRow
                  key={stat.key}
                  label={stat.key || "(unlabeled)"}
                  value={`${stat.count} · ${formatLatencyMs(stat.p50)} · ${formatLatencyMs(stat.p95)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mon-metrics-section" data-testid="monitor-metrics-errors">
          <h3 className="mon-kicker">
            Error counters <span className="mon-dim">— since gateway start; growth matters, not size</span>
          </h3>
          {errors.length === 0 ? (
            <div className="mon-metric-row">
              <span className="mon-metric-label tone-ok">no non-zero error counters</span>
              <span className="mon-mono mon-metric-value tone-ok">0</span>
            </div>
          ) : (
            <div className="mon-metrics-table">
              {errors.map((sample, index) => (
                <div
                  className="mon-metric-row"
                  key={`${sample.name}:${index}`}
                  title={`${sample.name}${
                    Object.keys(sample.labels).length
                      ? `{${Object.entries(sample.labels)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(",")}}`
                      : ""
                  }`}
                >
                  <span className="mon-metric-label">{describeErrorCounter(sample.name, sample.labels)}</span>
                  <span className="mon-mono mon-metric-value">{String(sample.value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Landing runs table: every run this gateway owns, paginated, shown in the
// main area while no run is selected. The gateway's listRuns filter has no
// offset/cursor, so pagination is client-side over the fetched window (see
// paginateRuns in ./monitorModel.ts). Same rows, same filters, same select
// handler as the rail — a scannable overview instead of an empty hero.
// ---------------------------------------------------------------------------

/** Compact `done+failed/total` from a run row's node-state summary (getRun
 * attaches it; plain listRuns rows without one render an em dash). */
export function RunProgressCell({ run }: { run: RunRow }) {
  const progress = isRecord(run) ? runProgress(run.summary) : null;
  if (!progress) return <span className="mon-dim">—</span>;
  return (
    <span
      className="mon-mono"
      data-testid="monitor-run-progress"
      title={`${progress.done} done · ${progress.failed} failed · ${progress.total} nodes`}
    >
      {progress.done + progress.failed}/{progress.total}
      {progress.failed > 0 ? <span className="tone-failed mon-table-failed"> · {progress.failed} failed</span> : null}
    </span>
  );
}

export function RunsTable({
  runs,
  loading,
  totalCount = runs.length,
  queryError,
  connStatus = "online",
  hasCachedData = runs.length > 0,
  onResetFilters,
  onRetry,
  page,
  onPageChange,
  onSelect,
  sort: sortProp,
  onSortChange,
  cursorRunId,
}: {
  runs: RunRow[];
  loading: boolean;
  totalCount?: number;
  queryError?: Error;
  connStatus?: MonitorConnectionStatus;
  hasCachedData?: boolean;
  onResetFilters?: () => void;
  onRetry?: () => void | Promise<void>;
  page: number;
  onPageChange: (page: number) => void;
  onSelect: (runId: string) => void;
  /** Controlled sort (the App lifts it so j/k keyboard order matches); uncontrolled falls back to local state. */
  sort?: RunsTableSort;
  onSortChange?: (sort: RunsTableSort) => void;
  /** The keyboard cursor row (j/k) — highlighted and kept scrolled into view. */
  cursorRunId?: string;
}) {
  // Triage order by default (attention first, newest first inside a band);
  // the Started header click-sorts pure time in either direction.
  const [internalSort, setInternalSort] = useState<RunsTableSort>("default");
  const sort = sortProp ?? internalSort;
  const setSort = onSortChange ?? setInternalSort;
  const sorted = useMemo(() => sortRunsForTable(runs, sort), [runs, sort]);
  const { pageRows, page: shownPage, pageCount, total } = paginateRuns(sorted, page, RUNS_PAGE_SIZE);
  const landingState = runsLandingState({
    visibleCount: total,
    totalCount,
    loading,
    queryError: queryError !== undefined,
    connectionStatus: connStatus,
    hasCachedData,
  });
  if (landingState === "connecting") {
    return (
      <div className="mon-empty mon-empty-hero" data-testid="monitor-empty-detail" data-state={landingState}>
        <div>Connecting to the Smithers gateway…</div>
        <div className="mon-dim">Runs will appear after the first successful response.</div>
      </div>
    );
  }
  if (landingState === "offline-without-cache") {
    return (
      <div
        className="mon-empty mon-empty-hero tone-failed"
        data-testid="monitor-empty-detail"
        data-state={landingState}
        role="alert"
      >
        <div>Gateway offline.</div>
        <div className="mon-dim">No last-known runs are available. Reconnecting automatically.</div>
      </div>
    );
  }
  if (landingState === "unauthorized") {
    return (
      <div
        className="mon-empty mon-empty-hero tone-failed"
        data-testid="monitor-empty-detail"
        data-state={landingState}
        role="alert"
      >
        <div>Unauthorized.</div>
        <div className="mon-dim">Re-open with smithers monitor to provide fresh gateway credentials.</div>
      </div>
    );
  }
  if (landingState !== "ready" && landingState !== "offline-with-cache") {
    return (
      <RunsZeroState
        state={landingState}
        testId="monitor-empty-detail"
        hero
        totalCount={totalCount}
        queryError={queryError}
        onResetFilters={onResetFilters}
        onRetry={onRetry}
      />
    );
  }
  const lastKnown = landingState === "offline-with-cache";
  if (lastKnown && total === 0) {
    return (
      <div className="mon-empty mon-empty-hero" data-testid="monitor-empty-detail" data-state={landingState}>
        <div>Gateway offline. Last-known runs are hidden by your filters.</div>
        <div className="mon-dim">Clear filters to inspect the cached results. They may be out of date.</div>
        {onResetFilters ? (
          <Button variant="outline" data-testid="monitor-empty-detail-reset" onClick={onResetFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  }
  const firstRow = (shownPage - 1) * RUNS_PAGE_SIZE + 1;
  const lastRow = Math.min(shownPage * RUNS_PAGE_SIZE, total);
  const startedIndicator = sort === "newest" ? "▾" : sort === "oldest" ? "▴" : "";
  return (
    <section
      className="mon-panel mon-runs-table-panel"
      data-state={landingState}
      aria-label={lastKnown ? "Last-known runs" : "Runs"}
    >
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          {lastKnown ? "Last-known runs" : "All runs"} <span className="mon-count">{total}</span>
        </h2>
        {sort === "default" ? <span className="mon-dim mon-sort-note">attention first · newest first</span> : null}
      </header>
      {lastKnown ? (
        <div className="mon-banner tone-waiting" data-testid="monitor-runs-last-known" role="status">
          Gateway offline. Every run shown below is last-known data and may be out of date.
        </div>
      ) : null}
      {queryError ? (
        <div className="mon-banner tone-failed" data-testid="monitor-runs-table-query-error" role="alert">
          <div>Couldn&apos;t refresh runs.</div>
          <div className="mon-dim">{queryError.message}</div>
          {onRetry ? (
            <Button variant="outline" data-testid="monitor-runs-table-query-error-retry" onClick={() => void onRetry()}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="mon-runs-scroll" role="region" aria-label="Runs table" tabIndex={0}>
        <Table className="mon-runs-table" data-testid="monitor-runs-table">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Workflow</TableHead>
              <TableHead scope="col">Progress</TableHead>
              <TableHead
                scope="col"
                aria-sort={sort === "default" ? undefined : sort === "newest" ? "descending" : "ascending"}
              >
                <button
                  type="button"
                  className="mon-th-sort"
                  data-testid="monitor-sort-started"
                  title="Sort by start time"
                  onClick={() => setSort(sort === "default" ? "newest" : sort === "newest" ? "oldest" : "default")}
                >
                  Started
                  {startedIndicator ? (
                    <span className="mon-sort-arrow" aria-hidden>
                      {" "}
                      {startedIndicator}
                    </span>
                  ) : null}
                </button>
              </TableHead>
              <TableHead scope="col">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((run) => (
              <TableRow
                key={run.runId}
                className={`mon-runs-table-row${run.runId === cursorRunId ? " is-kbcursor" : ""}`}
                data-run-id={run.runId}
                role="button"
                aria-current={run.runId === cursorRunId ? "true" : undefined}
                aria-label={`${run.workflowKey ?? "unknown workflow"}, run ${run.runId}, ${labelForStatus(run.status)}${lastKnown ? ", last-known" : ""}`}
                tabIndex={0}
                ref={
                  run.runId === cursorRunId
                    ? (el: HTMLTableRowElement | null) => el?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                onClick={() => onSelect(run.runId)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelect(run.runId);
                }}
              >
                <TableCell>
                  <StatusTag
                    status={run.status}
                    label={lastKnown ? `${labelForStatus(run.status)} · last-known` : undefined}
                    pulse={!lastKnown}
                  />
                </TableCell>
                <TableCell className="mon-table-workflow" title={run.workflowKey ?? "unknown workflow"}>
                  <span className="mon-table-workflow-name">{middleTruncate(run.workflowKey ?? "unknown", 56)}</span>
                  <span className="mon-mono mon-dim mon-table-runid">{shortRunId(run.runId)}</span>
                </TableCell>
                <TableCell>
                  <RunProgressCell run={run} />
                </TableCell>
                <TableCell className="mon-dim">
                  <Ago ms={run.startedAtMs ?? run.createdAtMs} />
                </TableCell>
                <TableCell className="mon-dim mon-mono">
                  {lastKnown && !isTerminalStatus(run.status) ? (
                    "last-known"
                  ) : (
                    <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={run.finishedAtMs} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <RunsPagination
        page={shownPage}
        pageCount={pageCount}
        firstRow={firstRow}
        lastRow={lastRow}
        total={total}
        onPageChange={onPageChange}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Execution tree.
// ---------------------------------------------------------------------------

const KIND_GLYPHS: Record<string, string> = {
  workflow: "◆",
  sequence: "▤",
  parallel: "▥",
  task: "●",
  approval: "✋",
  loop: "↻",
  foreach: "↻",
  timer: "◔",
  branch: "⑂",
  conditional: "⑂",
  subflow: "◇",
};

type TreeNode = TreeNodeLike & {
  name?: string;
  cardLabel?: string;
  kind?: string;
  iteration?: number;
  agent?: unknown;
  attempt?: number;
  maxAttempts?: number;
  prompt?: unknown;
  toolCalls?: unknown;
  children?: TreeNode[] | null;
};

/**
 * React-DevTools-style XML rendering of the execution tree: colored tags and
 * attributes, clickable chevrons, click-to-inspect — sharing the exact same
 * expansion state as the row view so toggling XML never loses your place.
 */
function XmlRow({
  node,
  depth,
  expandedOverrides,
  defaults,
  selectedNodeKey,
  onToggle,
  onSelect,
  selectDisabled,
}: {
  node: TreeNode;
  depth: number;
  expandedOverrides: ReadonlyMap<string, boolean>;
  defaults: ReadonlySet<string>;
  selectedNodeKey: string | undefined;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
  selectDisabled?: boolean;
}) {
  const key = treeNodeKey(node);
  const children = (node.children ?? []) as TreeNode[];
  const expanded = expandedOverrides.get(key) ?? defaults.has(key);
  const kind = (node.kind ?? "node").replace(/[^a-zA-Z0-9_.-]/g, "") || "Node";
  const tag = kind.charAt(0).toUpperCase() + kind.slice(1);
  const status = asString(node.status);
  const name = asString(node.name);
  const openTag = (
    <button
      type="button"
      className="mon-xml-open"
      onClick={selectDisabled ? undefined : () => onSelect(node)}
      aria-disabled={selectDisabled || undefined}
    >
      <span className="mon-xml-punct">&lt;</span>
      <span className="mon-xml-tag">{tag}</span>
      {node.id ? (
        <span className="mon-xml-attr">
          {" "}
          <span className="mon-xml-attr-name">id</span>=<span className="mon-xml-str">"{node.id}"</span>
        </span>
      ) : null}
      {name && name !== node.id ? (
        <span className="mon-xml-attr">
          {" "}
          <span className="mon-xml-attr-name">name</span>=<span className="mon-xml-str">"{name}"</span>
        </span>
      ) : null}
      {status ? (
        <span className="mon-xml-attr">
          {" "}
          <span className="mon-xml-attr-name">status</span>=
          <span className={`mon-xml-status tone-${toneForStatus(status)}`}>"{status}"</span>
        </span>
      ) : null}
      {typeof node.iteration === "number" && node.iteration > 0 ? (
        <span className="mon-xml-attr">
          {" "}
          <span className="mon-xml-attr-name">iteration</span>=<span className="mon-xml-str">"{node.iteration}"</span>
        </span>
      ) : null}
      <span className="mon-xml-punct">{children.length === 0 ? " />" : expanded ? ">" : ""}</span>
      {children.length > 0 && !expanded ? (
        <span className="mon-xml-punct">
          &gt;<span className="mon-xml-ellipsis">…</span>&lt;/<span className="mon-xml-tag">{tag}</span>&gt;
        </span>
      ) : null}
    </button>
  );
  return (
    <>
      <div
        className={`mon-xml-row${key === selectedNodeKey ? " is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="mon-tree-chevron"
            onClick={() => onToggle(key)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.cardLabel ?? node.name ?? node.id ?? key}`}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="mon-tree-chevron mon-dim" aria-hidden>
            ·
          </span>
        )}
        {openTag}
      </div>
      {expanded && children.length > 0 ? (
        <>
          {children.map((child) => (
            <XmlRow
              key={treeNodeKey(child)}
              node={child}
              depth={depth + 1}
              expandedOverrides={expandedOverrides}
              defaults={defaults}
              selectedNodeKey={selectedNodeKey}
              onToggle={onToggle}
              onSelect={onSelect}
              selectDisabled={selectDisabled}
            />
          ))}
          <div className="mon-xml-row" style={{ paddingLeft: 8 + depth * 16 }}>
            <span className="mon-tree-chevron" aria-hidden />
            <span className="mon-xml-punct">
              &lt;/<span className="mon-xml-tag">{tag}</span>&gt;
            </span>
          </div>
        </>
      ) : null}
    </>
  );
}

/** Leaf kinds own transcripts/outputs; everything else is structural grouping. */
const LEAF_KINDS = new Set(["task", "agent", "compute", "static"]);

/** One-line glyph legend, surfaced as a tooltip on each tree glyph. */
const KIND_LABELS: Record<string, string> = {
  workflow: "workflow",
  sequence: "sequence — runs children in order",
  parallel: "parallel — runs children concurrently",
  task: "task",
  approval: "approval gate",
  loop: "loop",
  foreach: "loop over items",
  timer: "timer wait",
  branch: "conditional branch",
  conditional: "conditional branch",
  subflow: "sub-workflow",
};

function TreeRow({
  node,
  depth,
  expandedOverrides,
  defaults,
  selectedNodeKey,
  durations,
  tokensById,
  onToggle,
  onSelect,
  selectDisabled,
}: {
  node: TreeNode;
  depth: number;
  expandedOverrides: ReadonlyMap<string, boolean>;
  defaults: ReadonlySet<string>;
  selectedNodeKey: string | undefined;
  durations?: ReadonlyMap<string, number>;
  /** nodeId → subtree token spend (+estimated in-flight), right-aligned beside the duration. */
  tokensById?: ReadonlyMap<string, { spent: number; inFlight?: number }>;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
  selectDisabled?: boolean;
}) {
  const key = treeNodeKey(node);
  const children = (node.children ?? []) as TreeNode[];
  const expanded = expandedOverrides.get(key) ?? defaults.has(key);
  const kindKey = (node.kind ?? "").toLowerCase();
  const glyph = KIND_GLYPHS[kindKey] ?? "○";
  const agentName = isRecord(node.agent) ? asString(node.agent.name) : asString(node.agent);
  const failedBelow = !expanded && hasFailedDescendant(node);
  // Containers read quieter than real tasks: dimmer name, and no status pill
  // unless the state is worth interrupting for (running/waiting/failed).
  const isContainer = !LEAF_KINDS.has(kindKey) && children.length > 0;
  const tone = toneForStatus(node.status);
  const showPill = !isContainer || tone === "failed" || tone === "waiting" || tone === "running";
  const durationMs = durations?.get(`${node.id ?? key}#${node.iteration ?? 0}`);
  const tokens = tokensById?.get(node.id ?? key);
  return (
    <>
      <div
        className={`mon-tree-row${key === selectedNodeKey ? " is-active" : ""}${isContainer ? " mon-tree-container" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="mon-tree-chevron"
            onClick={() => onToggle(key)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.cardLabel ?? node.name ?? node.id ?? key}`}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="mon-tree-chevron mon-dim" aria-hidden>
            ·
          </span>
        )}
        <button
          type="button"
          className="mon-tree-main"
          onClick={selectDisabled ? undefined : () => onSelect(node)}
          title={selectDisabled ? "Node selection is disabled while scrubbing frames" : undefined}
          aria-disabled={selectDisabled || undefined}
        >
          <span className="mon-tree-glyph mon-dim" title={KIND_LABELS[kindKey] ?? kindKey ?? "node"}>
            {glyph}
          </span>
          <span className="mon-tree-name">{node.cardLabel ?? node.name ?? node.id ?? key}</span>
          {agentName ? <span className="mon-chip">{agentName}</span> : null}
          {typeof node.iteration === "number" && node.iteration > 0 ? (
            <span className="mon-chip mon-dim">#{node.iteration}</span>
          ) : null}
          {failedBelow ? <ToneDot tone="failed" /> : null}
          {durationMs !== undefined ? (
            <span className="mon-mono mon-dim mon-tree-duration">{formatDurationMs(durationMs)}</span>
          ) : null}
          {tokens ? (
            <span
              className={`mon-mono mon-tree-tokens${tokens.inFlight !== undefined ? " mon-usage-est" : " mon-dim"}`}
              title={
                tokens.inFlight !== undefined
                  ? `${formatTokens(tokens.spent)} tokens measured · ~${formatTokens(tokens.inFlight)} more estimated while running`
                  : `${formatTokens(tokens.spent)} tokens${isContainer ? " (subtree)" : ""}`
              }
            >
              {tokens.inFlight !== undefined
                ? `~${formatTokens(tokens.spent + tokens.inFlight)}…`
                : formatTokens(tokens.spent)}
            </span>
          ) : null}
          {showPill ? <StatusTag status={node.status} /> : null}
        </button>
      </div>
      {expanded
        ? children.map((child) => (
            <TreeRow
              key={treeNodeKey(child)}
              node={child}
              depth={depth + 1}
              expandedOverrides={expandedOverrides}
              defaults={defaults}
              selectedNodeKey={selectedNodeKey}
              durations={durations}
              tokensById={tokensById}
              onToggle={onToggle}
              onSelect={onSelect}
              selectDisabled={selectDisabled}
            />
          ))
        : null}
    </>
  );
}

export function ExecutionTree({
  runId,
  treeQuery,
  selectedNodeKey,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
  onRetry,
  frameOverride,
  asXml,
  durations,
  tokensById,
}: {
  runId: string;
  /** The panel-level live tree query (shared with the token prediction). */
  treeQuery: UseGatewayRunTreeResult;
  selectedNodeKey: string | undefined;
  onSelectNode: (node: TreeNode) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
  /** Retry the live tree query after an initial failure. */
  onRetry?: () => void;
  /**
   * Frame-scrubber override: when set, render this static tree instead of the
   * live one and disable node selection. `root: null` means a successfully
   * loaded frame maps to an empty tree. While loading or unavailable, a
   * non-null root is the previous valid frame and remains visible.
   */
  frameOverride?: {
    root: TreeNode | null;
    loading: boolean;
    error?: Error;
    onRetry?: () => void;
    onReturnToLive?: () => void;
  };
  /** Render the tree as engine-style XML instead of expandable rows. */
  asXml?: boolean;
  /** nodeId#iteration → duration, right-aligned on settled rows. */
  durations?: ReadonlyMap<string, number>;
  /** nodeId → subtree token spend (+estimated in-flight), beside the duration. */
  tokensById?: ReadonlyMap<string, { spent: number; inFlight?: number }>;
}) {
  const { root: liveRoot, nodes, isLoading, error } = treeQuery;
  const isStatic = frameOverride !== undefined;
  const root = isStatic ? frameOverride.root : (liveRoot as TreeNode | null);
  const frameLoading = frameOverride?.loading ?? false;
  const frameError = frameLoading ? undefined : frameOverride?.error;
  // ?nodeId= deep link: select the node once it exists in the live tree.
  useEffect(() => {
    if (isStatic || !autoSelectNodeId || nodes.length === 0) return;
    const match = (nodes as TreeNode[]).find(
      (candidate) => candidate.id === autoSelectNodeId || treeNodeKey(candidate) === autoSelectNodeId,
    );
    if (match) {
      onSelectNode(match);
      onAutoSelected?.();
    }
  }, [autoSelectNodeId, nodes.length, isStatic]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  // Reset user toggles when switching runs.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    if (overrides.size > 0) setOverrides(new Map());
  }
  const defaults = useMemo(() => autoExpandKeys(root as TreeNodeLike | null), [root]);
  if (!isStatic && error) {
    return (
      <div className="mon-empty" data-testid="monitor-tree-error" role="alert">
        <div>Failed to load the execution tree.</div>
        <span className="mon-dim">{error.message}</span>
        {onRetry ? (
          <div className="mon-empty-actions">
            <Chip data-testid="monitor-tree-retry" onClick={onRetry}>
              Retry
            </Chip>
          </div>
        ) : null}
      </div>
    );
  }
  if (!isStatic && isLoading) {
    return (
      <div className="mon-empty" data-testid="monitor-tree-loading" role="status">
        Loading execution tree…
      </div>
    );
  }
  if (!root) {
    if (frameLoading) {
      return (
        <div className="mon-empty" data-testid="monitor-frame-loading" role="status">
          Loading frame…
        </div>
      );
    }
    if (frameError) {
      return (
        <div className="mon-empty" data-testid="monitor-frame-unavailable" role="alert">
          <div>Frame unavailable.</div>
          <span className="mon-dim">{frameError.message}</span>
          <div className="mon-empty-actions">
            {frameOverride?.onRetry ? (
              <Chip data-testid="monitor-frame-retry" onClick={frameOverride.onRetry}>
                Retry
              </Chip>
            ) : null}
            {frameOverride?.onReturnToLive ? (
              <Chip data-testid="monitor-frame-live" onClick={frameOverride.onReturnToLive}>
                Return to live
              </Chip>
            ) : null}
          </div>
        </div>
      );
    }
    return (
      <div
        className="mon-empty"
        data-testid={isStatic ? "monitor-frame-empty" : "monitor-tree-empty"}
        data-state="empty"
      >
        {isStatic ? "No nodes in this frame." : "No nodes recorded yet."}
      </div>
    );
  }
  const notice = frameLoading ? (
    <div className="mon-tree-state" data-testid="monitor-frame-loading" role="status">
      Loading frame… Showing the previous frame until it arrives.
    </div>
  ) : frameError ? (
    <div className="mon-tree-state mon-tree-state-error" data-testid="monitor-frame-unavailable" role="alert">
      <span>
        Frame unavailable. <span className="mon-dim">Showing the previous frame. {frameError.message}</span>
      </span>
      <span className="mon-tree-state-actions">
        {frameOverride?.onRetry ? (
          <Chip data-testid="monitor-frame-retry" onClick={frameOverride.onRetry}>
            Retry
          </Chip>
        ) : null}
        {frameOverride?.onReturnToLive ? (
          <Chip data-testid="monitor-frame-live" onClick={frameOverride.onReturnToLive}>
            Return to live
          </Chip>
        ) : null}
      </span>
    </div>
  ) : null;
  const tree = asXml ? (
    <div
      role="region"
      aria-label="Execution tree XML"
      tabIndex={0}
      className={`mon-tree mon-tree-xml${isStatic ? " is-static" : ""}`}
      data-testid="monitor-tree-xml"
    >
      <XmlRow
        node={root}
        depth={0}
        expandedOverrides={overrides}
        defaults={defaults}
        selectedNodeKey={selectedNodeKey}
        onToggle={(key) =>
          setOverrides((prev) => {
            const next = new Map(prev);
            const current = next.get(key) ?? defaults.has(key);
            next.set(key, !current);
            return next;
          })
        }
        onSelect={onSelectNode}
        selectDisabled={isStatic}
      />
    </div>
  ) : (
    <div
      role="region"
      aria-label="Execution tree"
      tabIndex={0}
      className={`mon-tree${isStatic ? " is-static" : ""}`}
      data-testid="monitor-tree"
    >
      <TreeRow
        node={root}
        depth={0}
        expandedOverrides={overrides}
        defaults={defaults}
        selectedNodeKey={selectedNodeKey}
        durations={durations}
        tokensById={tokensById}
        onToggle={(key) =>
          setOverrides((prev) => {
            const next = new Map(prev);
            const current = next.get(key) ?? defaults.has(key);
            next.set(key, !current);
            return next;
          })
        }
        onSelect={onSelectNode}
        selectDisabled={isStatic}
      />
    </div>
  );
  return (
    <>
      {notice}
      {tree}
    </>
  );
}

// ---------------------------------------------------------------------------
// Timeline: the run's task executions as a chronological flat list — loops
// unrolled into one row per (nodeId, iteration) — from the gateway's
// node-states route (the tree collection carries no timestamps). Polls every
// few seconds while the run is live; clicking a row selects that node in the
// inspector.
// ---------------------------------------------------------------------------

const TIMELINE_POLL_MS = 3_000;

/**
 * The run's node-state rows (per-attempt timing) from the gateway's
 * node-states route — shared by the Timeline view and the tree's per-node
 * duration labels. Polls while the run is live; terminal runs fetch once.
 */
function useNodeStates(runId: string, live: boolean): { rows: NodeStateRow[] | null; failed: boolean } {
  const [rows, setRows] = useState<NodeStateRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Reset only when switching runs — a live→settled flip must not blank the list.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    setRows(null);
    setFailed(false);
  }
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/node-states`);
        if (!response.ok) throw new Error(`node-states ${response.status}`);
        const body: unknown = await response.json();
        if (!cancelled) {
          setRows(nodeStateRowsOf(body));
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), TIMELINE_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, live]);
  return { rows, failed };
}

/** nodeId#iteration → wall-clock duration, for the tree's right-aligned duration labels. */
function durationsByKey(entries: readonly { key: string; durationMs?: number }[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (entry.durationMs !== undefined) map.set(entry.key, entry.durationMs);
  }
  return map;
}

function TimelinePanel({
  nodeStates,
  treeNodes,
  selectedNode,
  onSelectNode,
}: {
  nodeStates: { rows: NodeStateRow[] | null; failed: boolean };
  /** Flat live-tree nodes (from the panel-level tree query) for row → node lookup. */
  treeNodes: readonly TreeNode[];
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode) => void;
}) {
  const { rows, failed } = nodeStates;
  const now = useNowMs();
  const entries = useMemo(() => (rows ? buildTimeline(rows, now) : []), [rows, now]);
  // Prefer the real tree node (kind, agent, children intact) so the inspector
  // shows everything; a row the tree has not materialized yet falls back to a
  // minimal task node built from the state row.
  const selectEntry = (entry: ReturnType<typeof buildTimeline>[number]) => {
    const match = treeNodes.find(
      (candidate) => candidate.id === entry.nodeId && (candidate.iteration ?? 0) === entry.iteration,
    );
    onSelectNode(
      match ??
        ({
          id: entry.nodeId,
          iteration: entry.iteration,
          status: entry.state,
          kind: "task",
          name: entry.label ?? entry.nodeId,
        } as TreeNode),
    );
  };
  if (rows === null) {
    return (
      <div className="mon-empty">
        {failed
          ? "Could not load the timeline — the gateway did not answer the node-states request."
          : "Loading timeline…"}
      </div>
    );
  }
  if (entries.length === 0) return <div className="mon-empty">No task executions recorded yet.</div>;
  return (
    <div className="mon-timeline" data-testid="monitor-timeline" role="list">
      {entries.map((entry) => {
        const tone = toneForStatus(entry.state);
        const active =
          selectedNode !== undefined &&
          selectedNode.id === entry.nodeId &&
          (selectedNode.iteration ?? 0) === entry.iteration;
        return (
          <button
            key={entry.key}
            type="button"
            role="listitem"
            className={`mon-timeline-row${active ? " is-active" : ""}`}
            data-testid="monitor-timeline-row"
            data-node-id={entry.nodeId}
            data-iteration={entry.iteration}
            onClick={() => selectEntry(entry)}
          >
            <ToneDot tone={tone} pulse={tone === "running"} />
            <span className="mon-timeline-node" title={entry.label ?? entry.nodeId}>
              {entry.nodeId}
            </span>
            {entry.iteration > 0 ? <span className="mon-chip mon-dim">#{entry.iteration}</span> : null}
            {entry.lastAttempt != null ? (
              <span className="mon-dim mon-mono mon-timeline-attempt" title={`latest attempt ${entry.lastAttempt}`}>
                a{entry.lastAttempt}
              </span>
            ) : null}
            <span className="mon-timeline-right">
              <span className="mon-mono mon-timeline-duration">{formatDurationMs(entry.durationMs)}</span>
              <span className="mon-dim mon-timeline-when">
                {entry.endMs !== undefined ? <Ago ms={entry.endMs} /> : tone === "running" ? "running" : "—"}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution panel with a frame-by-frame scrubber (time-travel view). The
// "Frames" chip toggles scrub mode: prev/next buttons and a range input over
// the run's committed frames fetch getDevToolsSnapshot({ runId, frameNo }) and
// render THAT tree statically (via snapshotToGatewayRunNode) instead of the
// live one; "Live" (or toggling the chip off) returns to the live tree. The
// "Timeline" chip swaps the tree for the chronological task list above.
// ---------------------------------------------------------------------------

const SCRUB_DEBOUNCE_MS = 150;

/** Trail a fast-changing value (the range input) so fetches fire ~150ms after rest. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function ExecutionPanel({
  runId,
  live,
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
  usageEvents,
  usageLoading,
  usageFailed,
  nodeStates,
  treeQuery,
}: {
  runId: string;
  live: boolean;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode | undefined) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
  /** Run-level token-usage events from the gateway's full-run usage scan (lifted to RunDetail). */
  usageEvents: readonly TokenUsageEvent[];
  /** Initial usage fetch still in flight (no data yet); background refetches keep showing data. */
  usageLoading?: boolean;
  /** The usage query failed before any data landed. */
  usageFailed?: boolean;
  /** Per-attempt node timing rows, lifted to RunDetail so the header chip shares the poll. */
  nodeStates: { rows: NodeStateRow[] | null; failed: boolean };
  /** Live tree query, lifted to RunDetail so header/chip/panel share one subscription. */
  treeQuery: UseGatewayRunTreeResult;
}) {
  const [scrubbing, setScrubbing] = useState(false);
  // null = pinned to the latest frame until the user actually scrubs.
  const [frame, setFrame] = useState<number | null>(null);
  const [asXml, setAsXml] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  // Frames + XML are debugging instruments, not monitoring views — they stay
  // folded behind one Debug chip so the default header carries only what the
  // watching operator needs (tree + timeline).
  const [showDebug, setShowDebug] = useState(false);
  // Reset scrub state when switching runs.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    if (scrubbing) setScrubbing(false);
    if (frame !== null) setFrame(null);
    if (showTimeline) setShowTimeline(false);
    if (showUsage) setShowUsage(false);
  }
  // The latest committed frameNo, fetched only while scrub mode is on. The run
  // may commit more frames while scrubbing; the range simply spans what
  // existed when scrub mode opened.
  const latestQuery = useGatewayRpc("getDevToolsSnapshot", { runId }, { enabled: scrubbing });
  const latestFrameNo = asNumber(isRecord(latestQuery.data) ? latestQuery.data.frameNo : undefined);
  const bounds = frameScrubBounds(latestFrameNo ?? 0);
  const shownFrame = clampFrameNo(frame ?? bounds.max, latestFrameNo ?? 0);
  const debouncedFrame = useDebouncedValue(shownFrame, SCRUB_DEBOUNCE_MS);
  const frameEnabled = scrubbing && latestFrameNo !== undefined;
  const frameQuery = useGatewayRpc(
    "getDevToolsSnapshot",
    { runId, frameNo: clampFrameNo(debouncedFrame, latestFrameNo ?? 0) },
    { enabled: frameEnabled },
  );
  // Keep the previous frame's tree on screen while the next fetch is in
  // flight, so scrubbing reads as motion instead of blink-to-empty.
  const [scrubTree, setScrubTree] = useState<TreeNode | null>(null);
  useEffect(() => {
    if (!frameEnabled) {
      setScrubTree(null);
      return;
    }
    if (frameQuery.data === undefined) return;
    setScrubTree(snapshotToGatewayRunNode(frameQuery.data as DevToolsSnapshot) as TreeNode | null);
  }, [frameEnabled, frameQuery.data]);
  const scrubLoading = scrubbing && (latestQuery.loading || frameQuery.loading || debouncedFrame !== shownFrame);
  const scrubError = scrubbing ? (latestQuery.error ?? frameQuery.error) : undefined;
  const retryScrub = latestQuery.error ? latestQuery.refetch : frameQuery.refetch;
  const goLive = () => {
    setScrubbing(false);
    setFrame(null);
  };
  const step = (delta: number) => {
    if (latestFrameNo === undefined) return;
    setFrame(clampFrameNo(shownFrame + delta, latestFrameNo));
  };
  // Per-node durations for the tree's right-aligned labels (same node-states
  // feed as the Timeline view).
  const now = useNowMs();
  const durations = useMemo(
    () => (nodeStates.rows ? durationsByKey(buildTimeline(nodeStates.rows, now)) : undefined),
    [nodeStates.rows, now],
  );
  // One prediction per render feeds every tree row's token label and the
  // Usage panel: leaves read their own spend (+estimated in-flight while
  // running), containers read the subtree rollup of both.
  const timings = useMemo(() => nodeTimingsOf(nodeStates.rows), [nodeStates.rows]);
  const predictionTree = treeQuery.root as unknown as PredictionTreeNode | null;
  const usagePrediction = useMemo(
    () => predictRunUsage({ events: usageEvents, timings, tree: predictionTree, nowMs: now, live }),
    [usageEvents, timings, predictionTree, now, live],
  );
  const tokensById = useMemo(() => {
    if (!predictionTree) return undefined;
    const spent = new Map<string, number>();
    const inFlight = new Map<string, number>();
    for (const [nodeId, nodePrediction] of usagePrediction.perNode) {
      if (nodePrediction.spent > 0) spent.set(nodeId, nodePrediction.spent);
      if (nodePrediction.inFlight !== undefined && nodePrediction.inFlight >= 1) {
        inFlight.set(nodeId, nodePrediction.inFlight);
      }
    }
    const subtreeSpent = subtreeTokenTotals(predictionTree, spent);
    const subtreeInFlight = subtreeTokenTotals(predictionTree, inFlight);
    const map = new Map<string, { spent: number; inFlight?: number }>();
    for (const [nodeId, total] of subtreeSpent) {
      const extra = subtreeInFlight.get(nodeId) ?? 0;
      if (total <= 0 && extra < 1) continue;
      map.set(nodeId, { spent: total, ...(extra >= 1 ? { inFlight: extra } : {}) });
    }
    return map.size > 0 ? map : undefined;
  }, [predictionTree, usagePrediction]);
  return (
    <section className="mon-panel mon-tree-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Execution</h2>
        {selectedNode && !scrubbing ? <Chip onClick={() => onSelectNode(undefined)}>Clear selection</Chip> : null}
        <Chip
          on={showTimeline}
          data-testid="monitor-timeline-chip"
          onClick={() => {
            if (!showTimeline) {
              goLive();
              setShowUsage(false);
            }
            setShowTimeline((value) => !value);
          }}
          title="Every task execution in the order it ran — loops unrolled, one row per iteration"
        >
          Timeline
        </Chip>
        <Chip
          on={showUsage}
          data-testid="monitor-usage-panel-chip"
          onClick={() => {
            if (!showUsage) {
              goLive();
              setShowTimeline(false);
            }
            setShowUsage((value) => !value);
          }}
          title="Token burn for this run plus per-account rate limits — measured solid, estimates dimmed"
        >
          Usage
        </Chip>
        {showDebug ? (
          <Chip
            on={scrubbing}
            data-testid="monitor-frames-chip"
            onClick={() => {
              setShowTimeline(false);
              setShowUsage(false);
              if (scrubbing) goLive();
              else setScrubbing(true);
            }}
            title="Scrub the execution tree frame by frame instead of following it live"
          >
            Frames
          </Chip>
        ) : null}
        {showDebug ? (
          <Chip
            on={asXml && !showTimeline}
            data-testid="monitor-xml-chip"
            onClick={() => {
              if (showTimeline) {
                setShowTimeline(false);
                setAsXml(true);
                return;
              }
              setAsXml((value) => !value);
            }}
            title="Toggle between the expandable tree and the engine's XML view of the same nodes"
          >
            XML
          </Chip>
        ) : null}
        <Chip
          on={showDebug}
          data-testid="monitor-debug-chip"
          onClick={() => {
            // Folding the tools away also puts them down: back to the live tree.
            if (showDebug) {
              goLive();
              setAsXml(false);
            }
            setShowDebug((value) => !value);
          }}
          title="Power tools: frame-by-frame time travel and the engine's XML view"
        >
          Debug
        </Chip>
      </header>
      {scrubbing && !showTimeline && !showUsage ? (
        <div className="mon-scrub" data-testid="monitor-scrub">
          <Chip
            onClick={() => step(-1)}
            disabled={latestFrameNo === undefined || shownFrame <= bounds.min}
            aria-label="Previous frame"
          >
            ◀
          </Chip>
          <input
            className="mon-scrub-range"
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={shownFrame}
            disabled={latestFrameNo === undefined}
            onChange={(event) => {
              if (latestFrameNo === undefined) return;
              setFrame(clampFrameNo(Number(event.currentTarget.value), latestFrameNo));
            }}
            aria-label="Frame"
          />
          <Chip
            onClick={() => step(1)}
            disabled={latestFrameNo === undefined || shownFrame >= bounds.max}
            aria-label="Next frame"
          >
            ▶
          </Chip>
          <span className="mon-mono mon-dim mon-scrub-note">
            frame {latestFrameNo === undefined ? "… / …" : `${shownFrame} / ${bounds.max}`}
          </span>
          {scrubLoading ? <span className="mon-dim mon-scrub-loading">loading…</span> : null}
          {scrubError && !scrubLoading ? (
            <span className="mon-dim mon-scrub-note" title={scrubError.message}>
              frame unavailable
            </span>
          ) : null}
          <Chip onClick={goLive} title="Return to the live tree">
            Live
          </Chip>
        </div>
      ) : null}
      {showUsage ? (
        <UsagePanel usageEvents={usageEvents} usageLoading={usageLoading} usageFailed={usageFailed} />
      ) : showTimeline ? (
        <TimelinePanel
          nodeStates={nodeStates}
          treeNodes={treeQuery.nodes as TreeNode[]}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />
      ) : (
        <ExecutionTree
          runId={runId}
          treeQuery={treeQuery}
          selectedNodeKey={selectedNode ? treeNodeKey(selectedNode) : undefined}
          onSelectNode={onSelectNode}
          autoSelectNodeId={autoSelectNodeId}
          onAutoSelected={onAutoSelected}
          onRetry={() => location.reload()}
          frameOverride={
            scrubbing
              ? {
                  root: scrubTree,
                  loading: scrubLoading,
                  error: scrubError,
                  onRetry: () => void retryScrub(),
                  onReturnToLive: goLive,
                }
              : undefined
          }
          asXml={asXml}
          durations={durations}
          tokensById={tokensById}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Usage panel: per-account rate limits (gateway /v1/api/usage, server-cached
// 60s), this run's token burn as a per-minute sparkline, and per-agent /
// per-model breakdowns — all measured, estimates marked.
// ---------------------------------------------------------------------------

/** Remaining-quota bar row: fill is what is LEFT, tone follows the headroom. */
function UsageWindowBar({ row }: { row: UsageWindowRow }) {
  return (
    <span className="mon-usage-bar" aria-hidden>
      <span
        className={`mon-usage-bar-fill tone-${row.tone}`}
        style={{ width: `${Math.round((row.remainingFraction ?? 0) * 100)}%` }}
      />
    </span>
  );
}

/** Tiny inline SVG bar chart of tokens/min over the run's recent lifetime. */
function BurnSparkline({ buckets }: { buckets: readonly TokenBurnBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.tokens));
  const latest = buckets[buckets.length - 1]?.tokens ?? 0;
  return (
    <div data-testid="monitor-burn-sparkline">
      <svg
        className="mon-spark"
        viewBox={`0 0 ${buckets.length * 4} 28`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Token burn per minute — ${formatTokens(latest)} now, peak ${formatTokens(max)}`}
      >
        {buckets.map((bucket, index) => {
          const height = bucket.tokens <= 0 ? 0 : Math.max(1, Math.round((bucket.tokens / max) * 26));
          return (
            <rect
              key={bucket.startMs}
              x={index * 4}
              y={28 - height}
              width={3}
              height={height}
              rx={1}
              className={`mon-spark-bar${index === buckets.length - 1 ? " mon-spark-now" : ""}`}
            >
              <title>{`${formatTokens(bucket.tokens)} tok/min`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mon-dim mon-spark-legend">
        <span>{formatTokens(latest)} tok/min</span>
        <span>
          peak {formatTokens(max)} tok/min · {buckets.length}m
        </span>
      </div>
    </div>
  );
}

/** Per-agent / per-model token bars, width relative to the biggest consumer. */
function UsageShareBars({ rows }: { rows: readonly UsageShareRow[] }) {
  return (
    <div className="mon-usage-shares">
      {rows.map((row) => (
        <div className="mon-usage-row" key={row.key}>
          <span className="mon-usage-label" title={row.key}>
            {row.key}
          </span>
          <span className="mon-usage-bar" aria-hidden>
            <span
              className="mon-usage-bar-fill mon-usage-share-fill"
              style={{ width: `${Math.round(row.fraction * 100)}%` }}
            />
          </span>
          <span className="mon-mono mon-dim mon-usage-text">{formatTokens(row.tokens)}</span>
        </div>
      ))}
    </div>
  );
}

function UsagePanel({
  usageEvents,
  usageLoading,
  usageFailed,
}: {
  usageEvents: readonly TokenUsageEvent[];
  /** Initial full-scan fetch still in flight (no data yet) — not background refetches. */
  usageLoading?: boolean;
  /** The full-scan query failed before any data landed. */
  usageFailed?: boolean;
}) {
  const reportsQuery = useGatewayUsageReports();
  const reports = (reportsQuery.data ?? []) as UsageReportLike[];
  const windowRows = useMemo(() => usageWindowRows(reports), [reports]);
  const now = useNowMs();
  const fold = useMemo(() => foldTokenUsage(usageEvents), [usageEvents]);
  const buckets = useMemo(() => tokenBurnBuckets(usageEvents, 60_000, now, 30), [usageEvents, now]);
  const agentRows = useMemo(() => usageShareRows(fold.perAgent), [fold]);
  const modelRows = useMemo(() => usageShareRows(fold.perModel, 5), [fold]);
  return (
    <div className="mon-usage-panel" data-testid="monitor-usage-panel">
      <section className="mon-usage-section">
        <h3 className="mon-kicker">Rate limits</h3>
        {reportsQuery.data === undefined && reportsQuery.error ? (
          <div className="mon-dim">Could not load account usage: {reportsQuery.error.message}</div>
        ) : reportsQuery.data === undefined ? (
          <div className="mon-dim">Loading account usage…</div>
        ) : windowRows.length === 0 ? (
          <div className="mon-dim">No rate-limit windows reported for the registered accounts.</div>
        ) : (
          windowRows.map((row) =>
            row.unavailable ? (
              <div className="mon-usage-row" key={row.key}>
                <span className="mon-dim">
                  {row.label}: {row.text}
                </span>
              </div>
            ) : (
              <div className="mon-usage-row" key={row.key}>
                <span className="mon-usage-label" title={row.label}>
                  {row.label}
                </span>
                <UsageWindowBar row={row} />
                <span className={`mon-mono mon-usage-text${row.estimate ? " mon-usage-est" : ""}`}>
                  {row.estimate ? `~${row.text} est` : row.text}
                </span>
                <span className="mon-dim mon-usage-reset">
                  {row.resetsAtMs !== undefined ? <Countdown untilMs={row.resetsAtMs} /> : ""}
                </span>
              </div>
            ),
          )
        )}
      </section>
      <section className="mon-usage-section">
        <h3 className="mon-kicker">Burn — tokens/min</h3>
        {usageLoading ? (
          <div className="mon-dim">Loading token usage…</div>
        ) : usageFailed ? (
          <div className="mon-dim">Token usage is unavailable right now.</div>
        ) : fold.eventCount === 0 ? (
          <div className="mon-dim">No token usage reported for this run yet.</div>
        ) : (
          <BurnSparkline buckets={buckets} />
        )}
      </section>
      {fold.eventCount > 0 ? (
        <section className="mon-usage-section" data-testid="monitor-input-mix">
          <h3 className="mon-kicker">Input mix</h3>
          <div className="mon-usage-row">
            <span className="mon-usage-label">Fresh</span>
            <span className="mon-mono mon-usage-text">{formatTokens(fold.freshInputTokens)}</span>
          </div>
          <div className="mon-usage-row">
            <span className="mon-usage-label">Cache read</span>
            <span className="mon-mono mon-usage-text">{formatTokens(fold.cacheReadTokens)}</span>
          </div>
          <div className="mon-usage-row">
            <span className="mon-usage-label">Cache write</span>
            <span className="mon-mono mon-usage-text">{formatTokens(fold.cacheWriteTokens)}</span>
          </div>
          {fold.costUsd !== null ? (
            <div className="mon-usage-row">
              <span className="mon-usage-label">Estimated cost</span>
              <span className="mon-mono mon-usage-text">~${fold.costUsd.toFixed(4)}</span>
            </div>
          ) : null}
        </section>
      ) : null}
      {agentRows.length > 0 ? (
        <section className="mon-usage-section">
          <h3 className="mon-kicker">By agent</h3>
          <UsageShareBars rows={agentRows} />
        </section>
      ) : null}
      {modelRows.length > 0 ? (
        <section className="mon-usage-section">
          <h3 className="mon-kicker">By model</h3>
          <UsageShareBars rows={modelRows} />
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live event log with follow mode: auto-scrolls while you stay near the
// bottom; scrolling up pauses following; the Follow chip re-engages it.
// ---------------------------------------------------------------------------

const FOLLOW_THRESHOLD_PX = 80;

type EventView = "notable" | "activity" | "all";

const EVENT_VIEW_LABELS: Record<EventView, string> = {
  notable: "Notable",
  activity: "Activity",
  all: "All",
};

/** The shared run-event subscription, lifted to RunDetail so the log reads one
 * buffer. Token-usage totals come from useGatewayRunTokenUsage (full durable
 * scan), not this ring. */
type RunEventsState = ReturnType<typeof useGatewayRunEvents>;

export function EventLog({ runId, eventsState }: { runId: string; eventsState: RunEventsState }) {
  const { events: allEvents, lastHeartbeat, streaming, error, loading } = eventsState;
  const containerRef = useRef<HTMLOListElement | null>(null);
  const [following, setFollowing] = useState(true);
  // Default to Activity: lifecycle transitions plus the agent's visible work
  // (tool calls, chat output, frames, token usage). Heartbeats and session
  // bookkeeping stay one click away instead of drowning the log.
  const [view, setView] = useState<EventView>("activity");
  const events = useMemo(() => {
    // Heartbeats never render as rows — in "all" they collapse to one
    // liveness line so pulse traffic can't wallpaper the log.
    const { heartbeats, rest } = splitHeartbeatEvents(allEvents);
    if (view === "all") {
      return heartbeats.length > 0
        ? [
            ...rest,
            {
              event: "__heartbeats__",
              seq: heartbeats[heartbeats.length - 1]!.seq ?? 0,
              payload: { count: heartbeats.length },
              timestampMs: heartbeats[heartbeats.length - 1]!.timestampMs,
            },
          ]
        : rest;
    }
    return rest.filter((frame) => {
      const kind = eventViewFor(asString(frame.event) ?? "");
      return view === "notable" ? kind === "notable" : kind !== "chatter";
    });
  }, [allEvents, view]);

  useEffect(() => {
    if (!following) return;
    const el = containerRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [events.length, following, runId]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    setFollowing(nearBottom);
  };
  const eventListId = `monitor-events-${runId}`;
  const followStatusId = `${eventListId}-follow-status`;

  return (
    <section className="mon-panel mon-events-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Events{" "}
          <span className="mon-count">
            {events.length}
            {view === "all" ? "" : `/${allEvents.length}`}
          </span>
        </h2>
        {lastHeartbeat?.timestampMs ? (
          <span className="mon-dim mon-liveness" title="Latest task heartbeat — the engine is alive">
            <span className="mon-dot tone-ok mon-dot-pulse" aria-hidden /> heartbeat{" "}
            <Ago ms={lastHeartbeat.timestampMs} />
          </span>
        ) : null}
        <Chip
          on={view === "notable"}
          aria-controls={eventListId}
          aria-label="Show notable events"
          data-testid="monitor-events-filter-notable"
          onClick={() => setView("notable")}
          title="Node/run lifecycle, approvals, human requests"
        >
          Notable
        </Chip>
        <Chip
          on={view === "activity"}
          aria-controls={eventListId}
          aria-label="Show activity events"
          data-testid="monitor-events-filter-activity"
          onClick={() => setView("activity")}
          title="Notable plus tool calls, agent output, frames, and token usage"
        >
          Activity
        </Chip>
        <Chip
          on={view === "all"}
          aria-controls={eventListId}
          aria-label="Show all events"
          data-testid="monitor-events-filter-all"
          onClick={() => setView("all")}
          title="Every event except heartbeats (collapsed to one liveness row)"
        >
          All
        </Chip>
        <Chip
          on={following}
          aria-controls={eventListId}
          aria-label={following ? "Following new events" : "Resume following new events"}
          data-testid="monitor-events-follow"
          onClick={() => {
            setFollowing(true);
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          title="Auto-scroll to new events"
        >
          {following ? `${streaming ? "● " : ""}Following` : "Resume follow"}
        </Chip>
        <span
          id={followStatusId}
          className="sui-sr-only"
          role="status"
          aria-live="polite"
          data-testid="monitor-events-follow-status"
        >
          {following ? "Following new events." : "Event stream paused."}
        </span>
      </header>
      {error ? <div className="mon-banner tone-failed">{error.message}</div> : null}
      <ol
        id={eventListId}
        className="mon-events"
        ref={containerRef}
        onScroll={onScroll}
        data-testid="monitor-events"
        tabIndex={0}
        aria-label={`${EVENT_VIEW_LABELS[view]} event stream`}
        aria-describedby={followStatusId}
        aria-live={following ? "polite" : "off"}
        aria-relevant="additions text"
        aria-atomic={false}
        aria-busy={loading}
      >
        {events.length === 0 ? (
          <li className="mon-empty">
            {loading
              ? "Loading events…"
              : allEvents.length === 0
                ? "No events yet."
                : view === "notable"
                  ? "No notable events yet."
                  : "No activity yet."}
          </li>
        ) : null}
        {events.map((frame) => {
          if (frame.event === "__heartbeats__") {
            const count = isRecord(frame.payload) ? (asNumber(frame.payload.count) ?? 0) : 0;
            return (
              <li className="mon-event mon-event-heartbeats" key={`${runId}:heartbeats`}>
                <span className="mon-mono mon-dim">#{frame.seq}</span>
                <span className="mon-event-name mon-dim">TaskHeartbeat</span>
                <span className="mon-event-detail mon-dim">×{count} — collapsed; the engine is alive</span>
                <EventWhen ms={frame.timestampMs} />
              </li>
            );
          }
          const line = formatEventLine(frame);
          return (
            <li className="mon-event" key={`${runId}:${line.seq}`}>
              <span className="mon-mono mon-dim">#{line.seq}</span>
              <span className="mon-event-name">{line.name}</span>
              <span className="mon-event-detail mon-dim">{line.detail}</span>
              <EventWhen ms={frame.timestampMs} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Right-aligned relative event time (absolute on hover); "—" when the row predates timestamps. */
function EventWhen({ ms }: { ms: number | undefined }) {
  return (
    <span className="mon-dim mon-event-when" title={ms ? new Date(ms).toLocaleString() : undefined}>
      {ms ? <Ago ms={ms} /> : ""}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Health strip: one always-on green/yellow/red verdict per run — what it is
// doing right now and the concrete fix — recomputed live from gateway state.
// ---------------------------------------------------------------------------

function HealthStrip({
  runId,
  status,
  healthState,
  quota,
  runError,
  onResult,
}: {
  runId: string;
  status: string | undefined;
  healthState: string | undefined;
  quota: ReturnType<typeof quotaInfoOf>;
  /** Run-level failure message (errorJson) — the only error a run that died before its first task has. */
  runError?: string;
  onResult?: (kind: "ok" | "err", text: string) => void;
}) {
  const tree = useGatewayRunTree(runId);
  const approvalsQuery = useGatewayApprovals();
  const actions = useGatewayActions();
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  const { decide, decidingKey } = useApprovalDecide(onResult ?? (() => {}));
  const requestResume = async () => {
    setResumeBusy(true);
    setResumeNote(null);
    try {
      const response = await actions.resumeRun({ runId });
      setResumeNote(
        response.status === "already_terminal"
          ? "Run already reached a terminal state."
          : "Resume requested — an engine is re-attaching.",
      );
    } catch (error) {
      setResumeNote(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setResumeBusy(false);
    }
  };
  const treeNodes = tree.nodes ?? [];
  // The approvals blocking THIS run get inline actions — the run knows
  // exactly which gate parks it, so the decision lives in the banner instead
  // of sending the operator hunting through the inbox.
  const runApprovals = (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []).filter(
    (approval: unknown) => isRecord(approval) && approval.runId === runId,
  ) as ApprovalLike[];
  const approvalsCount = runApprovals.length;
  // One representative failure, so the strip can say WHY without a click.
  const failedTask = treeNodes.find(
    (node) => asString(node.status) === "failed" && !/^\d+$/.test(asString(node.id) ?? ""),
  );
  const failedNodeId = failedTask ? asString(failedTask.id) : undefined;
  const failedIteration = failedTask && typeof failedTask.iteration === "number" ? failedTask.iteration : 0;
  const sampleQuery = useGatewayNodeOutput({ runId, nodeId: failedNodeId, iteration: failedIteration });
  const sampleError = nodeErrorOf(sampleQuery.data);
  // A run that failed before its first task has no node error — fall back to
  // the run-level error so the red strip shows the actual cause.
  const failureSample =
    failedNodeId && sampleError
      ? { nodeId: failedNodeId, message: sampleError.message }
      : runError
        ? { nodeId: "run", message: runError }
        : null;
  // First paint: the tree collection is still pulling — a verdict computed on
  // an empty tree ("no tasks yet") is wrong, not neutral. Say loading.
  if (tree.isLoading && treeNodes.length === 0) {
    return (
      <div className="mon-banner tone-waiting mon-health" data-testid="monitor-health-strip">
        <div className="mon-health-headline">
          <span className="mon-dot mon-dot-pulse" aria-hidden /> <b>Assessing run health…</b>
        </div>
      </div>
    );
  }
  const diagnosis = diagnoseRun({
    runId,
    status,
    healthState,
    quota,
    approvalsCount,
    treeNodes,
    failureSample,
  });
  const tone = diagnosis.tone === "ok" ? "tone-ok" : diagnosis.tone === "crit" ? "tone-failed" : "tone-waiting";
  return (
    <div className={`mon-banner ${tone} mon-health`} data-testid="monitor-health-strip">
      <div className="mon-health-headline">
        <span className={`mon-health-dot ${tone}`} />
        <b>{diagnosis.headline}</b>
        {status === "waiting-quota" && quota?.resetAtMs ? (
          <span>
            {" · resumes ~"}
            {new Date(quota.resetAtMs).toLocaleTimeString()} (<Countdown untilMs={quota.resetAtMs} />)
          </span>
        ) : null}
      </div>
      <div className="mon-health-detail">{diagnosis.detail}</div>
      {quota?.blocked.length ? (
        <ul className="mon-quota-list">
          {quota.blocked.map((entry) => (
            <li key={entry.nodeId}>
              <span className="mon-mono">{entry.nodeId}</span>
              {entry.message ? <span className="mon-dim"> — {entry.message}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {runApprovals.map((approval) => (
        <div className="mon-health-approval" key={approvalKey(approval)}>
          <span className="mon-health-approval-title">{approval.requestTitle ?? approval.nodeId}</span>
          <ApprovalWait requestedAtMs={approval.requestedAtMs} />
          <ApprovalActions approval={approval} decide={decide} busy={decidingKey === approvalKey(approval)} />
        </div>
      ))}
      <div className="mon-health-fix mon-dim">{diagnosis.fix}</div>
      {diagnosis.action === "resume" ? (
        <div className="mon-health-actions">
          <Button
            variant="outline"
            className="mon-btn-ok"
            data-testid="monitor-health-resume"
            disabled={resumeBusy}
            title="Ask the gateway to re-attach an engine and resume this run now"
            onClick={() => void requestResume()}
          >
            {resumeBusy ? "Resuming…" : "Resume now"}
          </Button>
          {resumeNote ? <span className="mon-dim">{resumeNote}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node inspector.
// ---------------------------------------------------------------------------

/**
 * Make one transcript line scannable: drop completed-command echoes (the next
 * started line implies completion), strip the agent-name and shell-wrapper
 * noise from commands, and classify lines so commands, chat text, and
 * lifecycle metadata read differently.
 */
function formatLiveTranscriptLine(
  eventName: string,
  detail: string,
): { text: string; kind: "cmd" | "text" | "meta" } | null {
  let text = detail.replace(/^[a-z0-9_-]+ · /i, "");
  if (/^completed command · /.test(text)) return null;
  if (/^started command · /.test(text)) {
    text = text
      .replace(/^started command · /, "")
      .replace(/^\/bin\/(?:zsh|bash|sh) -l?c\s+/, "")
      .replace(/^["']|["']$/g, "");
    return { text: `$ ${text.slice(0, 220)}`, kind: "cmd" };
  }
  if (/^(started|completed)( turn| ·|$)/.test(text) || /^Node(Started|Finished|Failed|Retrying)/.test(eventName)) {
    return { text: text.slice(0, 160), kind: "meta" };
  }
  return { text: text.slice(0, 400), kind: "text" };
}

/**
 * AgentSessionEvent rows wrap the agent's own transcript stream (the codex /
 * claude CLI JSON items). They are by far the densest signal a live node
 * emits, so surface the useful items — chat text, commands, tool output —
 * and drop protocol noise. Without these the live panel sat on "No output"
 * for minutes while the agent was visibly working.
 */
function formatSessionTranscriptLine(payload: unknown): { text: string; kind: "cmd" | "text" | "meta" } | null {
  if (!isRecord(payload)) return null;
  const transcript = isRecord(payload.transcript) ? payload.transcript : undefined;
  const raw = transcript && isRecord(transcript.raw) ? transcript.raw : undefined;
  const item = raw && isRecord(raw.payload) ? raw.payload : undefined;
  if (!item) return null;
  const textOf = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) =>
          typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "",
        )
        .filter(Boolean)
        .join(" ");
    }
    if (isRecord(value) && typeof value.text === "string") return value.text;
    return "";
  };
  const itemType = String(item.type ?? "");
  if (itemType === "message") {
    const text = textOf(item.content).trim();
    return text ? { text: text.slice(0, 400), kind: "text" } : null;
  }
  if (itemType === "reasoning") return null;
  if (itemType === "local_shell_call" || itemType === "shell_call") {
    const action = isRecord(item.action) ? item.action : undefined;
    const command = action ? textOf(action.command).trim() : "";
    return command ? { text: `$ ${command.slice(0, 220)}`, kind: "cmd" } : null;
  }
  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const name = typeof item.name === "string" ? item.name : "tool";
    const args = typeof item.arguments === "string" ? item.arguments : typeof item.input === "string" ? item.input : "";
    // codex shell calls arrive as a function_call whose arguments hold the command.
    if (args.includes('"command"')) {
      try {
        const parsed: unknown = JSON.parse(args);
        const command = isRecord(parsed) ? textOf(parsed.command).trim() : "";
        if (command) return { text: `$ ${command.slice(0, 220)}`, kind: "cmd" };
      } catch {
        // fall through to the generic tool line
      }
    }
    return { text: `⚙ ${name}${args ? ` ${args.slice(0, 160)}` : ""}`, kind: "cmd" };
  }
  if (itemType.endsWith("_output")) {
    const text = textOf(item.output).trim();
    return text ? { text: text.slice(0, 300), kind: "meta" } : null;
  }
  return null;
}

/**
 * Live transcript for an in-flight node. The shared run-event ring drowns any
 * single node on a busy run (16 streaming agents rotate 500 events in
 * seconds), so this polls the gateway's per-node event filter incrementally:
 * the first poll returns a bounded tail of this node's history, and each
 * subsequent poll reads only past the last seen seq.
 */
function NodeLiveOutput({ runId, nodeId, live }: { runId: string; nodeId: string; live: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [lines, setLines] = useState<Array<{ seq: number; text: string; kind: "cmd" | "text" | "meta" }>>([]);
  const [failed, setFailed] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  useEffect(() => {
    setLines([]);
    setFailed(false);
    setLoadedOnce(false);
    let cancelled = false;
    // An absent cursor asks the node-filtered events route for its newest
    // bounded window. Once seeded, every poll advances forward from the last
    // observed sequence.
    let afterSeq: number | undefined;
    let inFlight = false;
    const poll = async () => {
      // The first poll scans history and can outlive the interval; overlapping
      // polls would both start from the same cursor and append the tail twice.
      if (inFlight) return;
      inFlight = true;
      try {
        const search = new URLSearchParams({ nodeId, limit: "120" });
        if (afterSeq !== undefined) search.set("afterSeq", String(afterSeq));
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/events?${search}`);
        if (!response.ok) throw new Error(`events ${response.status}`);
        const body = (await response.json()) as { data?: unknown[] };
        const rows = Array.isArray(body.data) ? body.data : [];
        const fresh: Array<{ seq: number; text: string; kind: "cmd" | "text" | "meta" }> = [];
        for (const raw of rows) {
          if (!isRecord(raw)) continue;
          const name = String(raw.event ?? "");
          const seq = asNumber(raw.seq) ?? 0;
          if (afterSeq === undefined || seq > afterSeq) afterSeq = seq;
          if (name === "AgentSessionEvent") {
            const formatted = formatSessionTranscriptLine(raw.payload);
            if (formatted) fresh.push({ seq, ...formatted });
            continue;
          }
          if (
            !/AgentEvent|AgentTraceEvent|NodeOutput|ToolCall|task\.output|agent\.|NodeStarted|NodeFinished|NodeFailed|NodeRetrying/i.test(
              name,
            )
          )
            continue;
          const line = formatEventLine({ event: name, seq, payload: raw.payload });
          const text = line.detail.startsWith(`${nodeId} · `) ? line.detail.slice(nodeId.length + 3) : line.detail;
          const formatted = formatLiveTranscriptLine(name, text || name);
          if (!formatted) continue;
          fresh.push({ seq, ...formatted });
        }
        if (!cancelled && fresh.length) {
          setLines((previous) => {
            const lastSeq = previous.length ? previous[previous.length - 1].seq : -1;
            const appended = fresh.filter((line) => line.seq > lastSeq);
            return appended.length ? [...previous, ...appended].slice(-120) : previous;
          });
        }
        if (!cancelled) {
          setFailed(false);
          setLoadedOnce(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    // Terminal nodes get a one-shot transcript; only live nodes keep polling.
    // Per-node reads are a single indexed SQL pass, so a tight cadence is
    // cheap and the transcript reads as streaming.
    const timer = live ? setInterval(() => void poll(), 1_200) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, nodeId, live]);
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  if (lines.length === 0) {
    return (
      <div className="mon-empty mon-dim">
        {failed ? (
          "Could not load this node's events."
        ) : !loadedOnce ? (
          <span className="mon-live-pending">
            <span className="mon-dot mon-dot-pulse" aria-hidden /> loading transcript…
          </span>
        ) : (
          "No output from this node yet — its events land here as they arrive."
        )}
      </div>
    );
  }
  return (
    <div className="mon-output mon-live-output" ref={containerRef} data-testid="monitor-live-output">
      {lines.map((line) => (
        <div key={line.seq} className={`mon-live-line mon-live-${line.kind}`}>
          {line.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff rendering. Unified-diff strings (node diffs from the gateway's
// getNodeDiff, and output fields that carry a raw patch) render through
// @pierre/diffs — syntax-colored added/removed lines — behind a
// collapsed-by-default summary ("N files, +X/−Y") so a big patch never
// swamps the inspector.
// ---------------------------------------------------------------------------

/**
 * A patch as a proper diff view. Parsing runs per `diff --git` chunk: real
 * bundles mix cleanly parseable files with ones @pierre/diffs' strict hunk
 * parser rejects (binary patches, odd counts), so the parseable files render
 * syntax-colored and the rejects fall back to raw text below — one bad file
 * never blanks the whole diff.
 */
function PatchDiffView({ patch }: { patch: string }) {
  const { files, rejected } = useMemo(() => {
    const parsedFiles: ReturnType<typeof processPatch>["files"] = [];
    const rawChunks: string[] = [];
    for (const [index, chunk] of splitPatchText(patch).entries()) {
      try {
        parsedFiles.push(...processPatch(chunk, `smithers-monitor-${index}`, true).files);
      } catch {
        rawChunks.push(chunk);
      }
    }
    return { files: parsedFiles, rejected: rawChunks };
  }, [patch]);
  const dark = isDarkTheme();
  const items: CodeViewItem[] = files.map((file, index) => ({
    id: `${file.name ?? index}`,
    type: "diff",
    fileDiff: file,
  }));
  return (
    <div className="mon-diff-view" data-testid="monitor-diff-view">
      {items.length > 0 ? (
        <CodeView
          disableWorkerPool
          items={items}
          options={{
            collapsedContextThreshold: 12,
            diffIndicators: "bars",
            diffStyle: "unified",
            hunkSeparators: "metadata",
            overflow: "wrap",
            theme: dark ? "github-dark" : "github-light",
            themeType: dark ? "dark" : "light",
          }}
        />
      ) : null}
      {rejected.length > 0 ? (
        <>
          {items.length > 0 ? (
            <div className="mon-dim mon-diff-raw-note">
              {rejected.length} {rejected.length === 1 ? "file" : "files"} shown as raw patch text (not parseable as a
              clean unified diff):
            </div>
          ) : null}
          <pre className="mon-output mon-diff-raw">{rejected.join("\n")}</pre>
        </>
      ) : null}
    </div>
  );
}

/**
 * Collapsed-by-default diff block: the summary line carries the honest counts
 * ("N files, +X/−Y"); the diff view only mounts on first expand, so shiki
 * never tokenizes patches nobody opened.
 */
function CollapsedDiff({
  patch,
  summaryText,
  label,
  testId,
}: {
  patch: string;
  summaryText?: string;
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => diffSummaryOf(patch), [patch]);
  return (
    <details
      className="mon-diff"
      data-testid={testId ?? "monitor-diff"}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="mon-diff-summary">
        <span className="mon-diff-caret" aria-hidden>
          ▸
        </span>
        {label ? <span className="mon-diff-label mon-mono">{label}</span> : null}
        <span className="mon-diff-stat mon-mono">{summaryText ?? formatDiffSummary(summary)}</span>
      </summary>
      {open ? <PatchDiffView patch={patch} /> : null}
    </details>
  );
}

/**
 * The node's recorded VCS diff (what this task's attempt changed on disk),
 * fetched from the gateway's getNodeDiff route. Only settled nodes have one
 * (the route refuses in-flight attempts); nodes without a recorded diff — the
 * common case for compute tasks — simply show nothing.
 */
function NodeDiffSection({
  runId,
  nodeId,
  iteration,
  enabled,
}: {
  runId: string;
  nodeId: string;
  iteration: number;
  enabled: boolean;
}) {
  const [patches, setPatches] = useState<Array<{ path: string; diff: string }>>([]);
  useEffect(() => {
    setPatches([]);
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const search = new URLSearchParams({ iteration: String(iteration) });
        const response = await fetch(
          `/v1/api/nodes/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}/diff?${search}`,
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled) setPatches(diffPatchesOf(body));
      } catch {
        // No recorded diff (or a VCS error) just hides the section.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId, nodeId, iteration, enabled]);
  if (patches.length === 0) return null;
  const combined = patches.map((patch) => patch.diff).join("\n");
  const rollup = sumDiffSummaries(patches.map((patch) => diffSummaryOf(patch.diff)));
  return (
    <InspectorSection title="Diff">
      <CollapsedDiff
        patch={combined}
        summaryText={formatDiffSummary({ ...rollup, files: patches.length })}
        testId="monitor-node-diff"
      />
    </InspectorSection>
  );
}

/** Envelope bookkeeping already shown in the inspector's meta grid. */
const OUTPUT_RESERVED_KEYS = new Set(["runId", "nodeId", "iteration"]);

/**
 * A node's structured output, one labeled block per field instead of one raw
 * JSON dump. Strings render verbatim (multiline intact), scalars sit inline
 * next to their key, and nested values pretty-print on their own.
 */
function OutputFields({ row }: { row: unknown }) {
  if (!isRecord(row)) {
    return <pre className="mon-output">{formatOutputValue(row)}</pre>;
  }
  const entries = Object.entries(row);
  const fields = entries.filter(([key]) => !OUTPUT_RESERVED_KEYS.has(key));
  const shown = fields.length > 0 ? fields : entries;
  if (shown.length === 0) {
    return <pre className="mon-output">{formatOutputValue(row)}</pre>;
  }
  return (
    <div className="mon-output mon-output-fields" data-testid="monitor-output-fields">
      {shown.map(([key, value]) => {
        const scalar =
          value === null || typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : typeof value === "string" && value.length <= 80 && !value.includes("\n")
              ? value
              : undefined;
        return (
          <div className="mon-output-field" key={key}>
            <span className="mon-output-key mon-mono">{key}</span>
            {scalar !== undefined ? (
              <span className="mon-output-scalar mon-mono">{scalar}</span>
            ) : looksLikeUnifiedDiff(value) ? (
              <CollapsedDiff patch={value as string} testId="monitor-output-diff" />
            ) : (
              <pre className="mon-output-val">{formatOutputValue(value)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TERMINAL_NODE_TONES = new Set(["ok", "failed", "cancelled"]);

/**
 * One collapsible inspector section. Uncontrolled `<details>` (React writes
 * `open` once and the prop never changes, so it never fights the user's
 * toggle) with the open state mirrored into React only to unmount closed
 * bodies — a collapsed Transcript stops polling, a collapsed Diff unmounts
 * its tokenized view. State lives at the panel level, so collapse choices
 * survive switching between nodes.
 */
function InspectorSection({
  title,
  testId,
  defaultOpen = true,
  actions,
  children,
}: {
  title: string;
  testId?: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="mon-section"
      data-testid={testId}
      open={defaultOpen}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="mon-kicker mon-section-summary">
        <span className="mon-diff-caret" aria-hidden>
          ▸
        </span>
        <span className="mon-section-title">{title}</span>
        {actions ? (
          <span
            className="mon-section-actions"
            onClick={(event) => {
              // Buttons share the summary row; their clicks must not toggle
              // the section.
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {actions}
          </span>
        ) : null}
      </summary>
      {open ? <div className="mon-section-body">{children}</div> : null}
    </details>
  );
}

/**
 * The AI "what happened" recap at the top of the inspector. The gateway's
 * whatHappened RPC narrates with the host-configured cheap agent and falls
 * back to a deterministic fact summary, so this renders something for every
 * settled node; errors just hide the panel.
 */
function NodeWhatHappened({
  runId,
  nodeId,
  iteration,
  status,
}: {
  runId: string;
  nodeId: string;
  iteration: number;
  status?: string;
}) {
  const enabled = nodeSummaryEligible(status);
  const summary = useGatewayRpc("whatHappened", { runId, nodeId, iteration }, { enabled });
  if (!enabled || summary.error) return null;
  return (
    <InspectorSection title="What happened" testId="monitor-what-happened">
      {summary.data ? (
        <>
          <div className="mon-what-summary">{summary.data.summary}</div>
          <div className="mon-what-source mon-dim">
            {summary.data.source === "agent"
              ? `narrated by ${summary.data.agentId ?? "agent"}`
              : "recorded facts (no narrator agent)"}
          </div>
        </>
      ) : (
        <div className="mon-empty mon-dim">Summarizing what happened…</div>
      )}
    </InspectorSection>
  );
}

function isDarkTheme(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function NodeInspector({
  runId,
  node,
  scores,
  usageEvents,
  onResult,
  onClose,
}: {
  runId: string;
  node: TreeNode;
  scores: RunScores;
  /** Run-level token-usage events; folded per node for the Details usage rows. */
  usageEvents?: readonly TokenUsageEvent[];
  onResult: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}) {
  const nodeId = node.id ?? treeNodeKey(node);
  const nodeUsage = useMemo(
    () => (usageEvents ? nodeUsageBreakdown(usageEvents, nodeId) : undefined),
    [usageEvents, nodeId],
  );
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: node.iteration ?? 0 });
  // The first output fetch often lands while the node is still running
  // ("pending"); without a refetch when the lifecycle advances the panel
  // would keep claiming "No output recorded" after the row was written.
  const outputRefreshKey = `${String(node.status ?? "")}:${asNumber(node.attempt) ?? 0}`;
  const prevOutputRefreshKey = useRef(outputRefreshKey);
  useEffect(() => {
    if (prevOutputRefreshKey.current !== outputRefreshKey) {
      prevOutputRefreshKey.current = outputRefreshKey;
      void output.refetch();
    }
  }, [outputRefreshKey, output.refetch]);
  const row = rowOf(output.data);
  const failure = nodeErrorOf(output.data);
  const isLive = !TERMINAL_NODE_TONES.has(String(node.status ?? ""));
  const toolCalls = asArray(node.toolCalls).filter(isRecord);
  // The task's initial prompt, carried on the snapshot from the latest
  // attempt's metadata (queued nodes have no attempt yet, so no section).
  const promptText = asString(node.prompt);
  // Structured agent metadata (declared assignment + what actually ran) when
  // the snapshot carries it; legacy rows may still hold a plain string.
  const agentInfo = isRecord(node.agent) ? node.agent : undefined;
  const agentName = agentInfo ? asString(agentInfo.name) : asString(node.agent);
  const agentEngine = agentInfo ? asString(agentInfo.engine) : undefined;
  const agentModel = agentInfo ? asString(agentInfo.model) : undefined;
  const agentRanOn = agentInfo && isRecord(agentInfo.ranOn) ? agentInfo.ranOn : undefined;
  const ranOnEngine = agentRanOn ? asString(agentRanOn.engine) : undefined;
  const ranOnModel = agentRanOn ? asString(agentRanOn.model) : undefined;
  const declaredLine = [agentEngine, agentModel].filter(Boolean).join(" · ");
  const ranOnLine = [ranOnEngine, ranOnModel].filter(Boolean).join(" · ");
  const agentChain = asArray(agentInfo?.chain)
    .filter(isRecord)
    .map((entry) => asString(entry.name) ?? [asString(entry.engine), asString(entry.model)].filter(Boolean).join(" · "))
    .filter(Boolean);
  const nodeAttempt = asNumber(node.attempt);
  const nodeMaxAttempts = asNumber(node.maxAttempts);
  // Hijack affordance: only nodes whose attempts recorded a resumable agent
  // session get a button (live run + live node = hand-off; settled run =
  // reopen the session post-mortem). Compute nodes never show one.
  const runQuery = useGatewayRun(runId);
  const runStatus = isRecord(runQuery.data) ? asString(runQuery.data.status) : undefined;
  const [hijackSession, setHijackSession] = useState<{
    engine: string;
    action: { kind: "hijack" | "reopen"; label: string };
  } | null>(null);
  // Containers (parallel, sequence, loop, worktree, merge-queue, …) group
  // other nodes and never own a transcript or structured output — showing
  // those panels there is pure noise. Leaf kinds keep the full inspector.
  const kind = String(node.kind ?? "").toLowerCase();
  const isContainer = !["task", "agent", "compute", "static"].includes(kind) && (node.children?.length ?? 0) > 0;
  // Retry affordance: failed leaf tasks get a "Retry task" button. The RPC
  // resets the node (and everything that ran after it) with the same library
  // machinery as `smithers retry-task`, then resumes the run — so it is only
  // enabled once the run itself has settled (a live engine owns its state).
  const nodeFailed = toneForStatus(node.status) === "failed" && !isContainer;
  const retryEnabled = canRetryTask(node.status, runStatus);
  const [retryBusy, setRetryBusy] = useState(false);
  const retryArm = useArmConfirm();
  const retryArmed = retryArm.isArmed("retry");
  const retryTask = async () => {
    if (!retryArm.armOrConfirm("retry")) return;
    setRetryBusy(true);
    try {
      const response = await fetch(
        `/v1/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ iteration: node.iteration ?? 0 }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      const envelope = isRecord(body) ? body : {};
      if (!response.ok || envelope.ok === false) {
        const error = isRecord(envelope.error) ? asString(envelope.error.message) : undefined;
        throw new Error(error ?? `retry failed (${response.status})`);
      }
      onResult("ok", `Retry requested for ${nodeId} — the run is resuming.`);
    } catch (error) {
      onResult("err", `Retry failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRetryBusy(false);
    }
  };
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const child of node.children ?? []) {
      const status = String(child.status ?? "unknown");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [node]);
  return (
    <aside className="mon-inspector" data-testid="monitor-inspector">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Node</h2>
        {nodeFailed ? (
          <Button
            variant={retryArmed ? "destructive" : "outline"}
            data-testid="monitor-retry-task"
            disabled={!retryEnabled || retryBusy}
            title={
              retryArmed
                ? "Click again to confirm — this resets the task and everything after it"
                : retryEnabled
                  ? "Reset this task (and every task that ran after it), then resume the run"
                  : "The run is still executing — pause or cancel it before retrying this task"
            }
            onClick={() => void retryTask()}
          >
            {retryBusy ? "Retrying…" : retryArmed ? "Confirm retry?" : "Retry task"}
          </Button>
        ) : null}
        <HijackCandidateButton
          runId={runId}
          nodeId={nodeId}
          runStatus={runStatus}
          nodeLive={isLive}
          onOpen={(candidate, action) => setHijackSession({ engine: candidate.engine, action })}
        />
        <StatusTag status={node.status} />
        <Chip
          onClick={onClose}
          aria-label="Close inspector"
          title="Close inspector (Esc)"
          data-testid="monitor-inspector-close"
        >
          ✕
        </Chip>
      </header>
      {hijackSession ? (
        // The hand-off surface is the shared oneshot UI (goal, KPIs, chat,
        // diff, events, and the PTY terminal), opened on its terminal tab and
        // maximizable to fill the viewport — the monitor owns no hijack markup
        // of its own.
        <OneshotSurface
          runId={runId}
          variant="overlay"
          initialTab="terminal"
          hijackNodeId={nodeId}
          title={`${hijackSession.action.label}: ${nodeId} · ${hijackSession.engine}`}
          onClose={() => setHijackSession(null)}
          className="mon-hijack-surface"
          data-testid="monitor-hijack-modal"
        />
      ) : null}
      <div className="mon-inspector-title">{node.cardLabel ?? node.name ?? nodeId}</div>
      <NodeWhatHappened runId={runId} nodeId={nodeId} iteration={node.iteration ?? 0} status={node.status} />
      <NodeScoreChips nodeId={nodeId} scores={scores} />
      <InspectorSection title="Details" testId="monitor-node-details">
        <dl className="mon-meta-grid">
          <dt>id</dt>
          <dd className="mon-mono">{nodeId}</dd>
          <dt>kind</dt>
          <dd>{node.kind ?? "—"}</dd>
          {agentName ? (
            <>
              <dt>agent</dt>
              <dd>{agentName}</dd>
            </>
          ) : null}
          {declaredLine && declaredLine !== agentName ? (
            <>
              <dt>engine</dt>
              <dd className="mon-mono" data-testid="monitor-agent-engine">
                {declaredLine}
              </dd>
            </>
          ) : null}
          {ranOnLine && ranOnLine !== declaredLine ? (
            <>
              <dt>ran on</dt>
              <dd className="mon-mono" data-testid="monitor-agent-ran-on">
                {ranOnLine}
              </dd>
            </>
          ) : null}
          {agentChain.length > 1 ? (
            <>
              <dt>failover</dt>
              <dd className="mon-mono" data-testid="monitor-agent-chain">
                {agentChain.join(" → ")}
              </dd>
            </>
          ) : null}
          {typeof nodeAttempt === "number" && nodeAttempt > 0 ? (
            <>
              <dt>attempt</dt>
              <dd className="mon-mono" data-testid="monitor-agent-attempt">
                {typeof nodeMaxAttempts === "number" && nodeMaxAttempts > 0
                  ? `${nodeAttempt} of ${nodeMaxAttempts}`
                  : nodeAttempt}
              </dd>
            </>
          ) : null}
          {typeof node.iteration === "number" ? (
            <>
              <dt>iteration</dt>
              <dd className="mon-mono">{node.iteration}</dd>
            </>
          ) : null}
          {nodeUsage ? (
            <>
              <dt>tokens</dt>
              <dd className="mon-mono" data-testid="monitor-node-tokens">
                {formatTokens(nodeUsage.total)}
              </dd>
              <dt>input</dt>
              <dd className="mon-mono">{formatTokens(nodeUsage.input)}</dd>
              <dt>output</dt>
              <dd className="mon-mono">{formatTokens(nodeUsage.output)}</dd>
              {nodeUsage.cacheRead > 0 ? (
                <>
                  <dt>cache read</dt>
                  <dd className="mon-mono">{formatTokens(nodeUsage.cacheRead)}</dd>
                </>
              ) : null}
              {nodeUsage.cacheWrite > 0 ? (
                <>
                  <dt>cache write</dt>
                  <dd className="mon-mono">{formatTokens(nodeUsage.cacheWrite)}</dd>
                </>
              ) : null}
              {nodeUsage.reasoning > 0 ? (
                <>
                  <dt>reasoning</dt>
                  <dd className="mon-mono">{formatTokens(nodeUsage.reasoning)}</dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
        {nodeUsage && nodeUsage.attempts.length > 1 ? (
          <div className="mon-usage-attempts" data-testid="monitor-node-usage-attempts">
            {nodeUsage.attempts.map((attempt) => (
              <div className="mon-usage-attempt" key={`${attempt.iteration ?? 0}:${attempt.attempt ?? 0}`}>
                <span className="mon-mono">
                  a{attempt.attempt ?? 0}
                  {attempt.iteration !== undefined && attempt.iteration > 0 ? ` #${attempt.iteration}` : ""}
                </span>
                {attempt.model ? <span className="mon-dim mon-usage-attempt-model">{attempt.model}</span> : null}
                <span className="mon-mono mon-dim">{formatTokens(attempt.total)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </InspectorSection>
      {promptText ? (
        <InspectorSection title="Prompt" testId="monitor-node-prompt">
          <pre className="mon-output mon-prompt">{promptText}</pre>
        </InspectorSection>
      ) : null}
      {toolCalls.length > 0 ? (
        <InspectorSection title={`Tool calls (${toolCalls.length})`} testId="monitor-node-toolcalls">
          <div className="mon-toolcalls">
            {toolCalls.map((call, index) => (
              <div className="mon-toolcall" key={index}>
                <span className="mon-mono">{asString(call.name) ?? asString(call.tool) ?? "tool"}</span>
                <StatusTag status={asString(call.status) ?? asString(call.state)} />
              </div>
            ))}
          </div>
        </InspectorSection>
      ) : null}
      {failure && !isContainer ? (
        <InspectorSection title="Failure" testId="monitor-node-failure">
          <div className="mon-banner tone-failed">
            {[failure.name, failure.code].filter(Boolean).join(" · ")}
            {typeof failure.attempt === "number" ? ` · attempt ${failure.attempt}` : ""}
            {failure.agent ? ` · ${failure.agent}` : ""}
          </div>
          <pre className="mon-output mon-failure">{failure.message}</pre>
        </InspectorSection>
      ) : null}
      {isContainer ? (
        <InspectorSection title="Children" testId="monitor-node-children">
          {childCounts.length > 0 ? (
            <div className="mon-child-rollup" data-testid="monitor-child-rollup">
              {childCounts.map(([status, count]) => (
                <span key={status} className="mon-child-stat">
                  <ToneDot tone={toneForStatus(status)} /> {count} {labelForStatus(status)}
                </span>
              ))}
            </div>
          ) : (
            <div className="mon-empty mon-dim">No children yet.</div>
          )}
          <div className="mon-dim mon-container-note">
            {String(node.kind ?? "container")} nodes group other nodes — select a task inside for its transcript and
            output.
          </div>
        </InspectorSection>
      ) : (
        <>
          <InspectorSection
            title={isLive ? "Live output" : "Transcript"}
            testId="monitor-node-transcript"
            actions={
              <HijackCandidateButton
                runId={runId}
                nodeId={nodeId}
                runStatus={runStatus}
                nodeLive={isLive}
                compact
                onOpen={(candidate, action) => setHijackSession({ engine: candidate.engine, action })}
              />
            }
          >
            <NodeLiveOutput runId={runId} nodeId={nodeId} live={isLive} />
          </InspectorSection>
          <InspectorSection title="Output" testId="monitor-node-output">
            {row ? (
              <OutputFields row={row} />
            ) : output.loading ? (
              <div className="mon-empty mon-dim">
                <span className="mon-live-pending">
                  <span className="mon-dot mon-dot-pulse" aria-hidden /> loading output…
                </span>
              </div>
            ) : output.error ? (
              <div className="mon-empty mon-dim" data-testid="monitor-output-error">
                Couldn't load output: {output.error.message}
              </div>
            ) : (
              <div className="mon-empty mon-dim">
                {failure ? (
                  "The node failed before producing output."
                ) : isLive ? (
                  <span className="mon-live-pending">
                    <span className="mon-dot mon-dot-pulse" aria-hidden /> running — structured output lands here when
                    the node finishes
                  </span>
                ) : (
                  "No output recorded for this node."
                )}
              </div>
            )}
          </InspectorSection>
          <NodeDiffSection runId={runId} nodeId={nodeId} iteration={node.iteration ?? 0} enabled={!isLive} />
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Run detail (header + lifecycle actions + tree + events).
// ---------------------------------------------------------------------------

/**
 * Header token chip: measured spend solid, predicted total range and ETA dim
 * and tilde-marked. Subscribes to the shared 1s clock itself so the in-flight
 * estimate ticks without re-rendering the whole run detail.
 */
function RunUsageChip({
  events,
  timings,
  tree,
  live,
}: {
  events: readonly TokenUsageEvent[];
  timings: readonly NodeTiming[];
  tree: PredictionTreeNode | null;
  live: boolean;
}) {
  const now = useNowMs();
  const chip = useMemo(
    () => runUsageChipOf(predictRunUsage({ events, timings, tree, nowMs: now, live }), { live }),
    [events, timings, tree, live, now],
  );
  const usage = useMemo(() => foldTokenUsage(events), [events]);
  return (
    <span
      className="mon-usage-chip"
      title={`${chip.title}${usage.costUsd === null ? "" : ` · estimated cost $${usage.costUsd.toFixed(4)}`}`}
      data-testid="monitor-usage-chip"
    >
      <span className="mon-mono">{chip.spent}</span>
      {usage.costUsd !== null ? <span className="mon-usage-est">&nbsp;· ~${usage.costUsd.toFixed(4)}</span> : null}
      {chip.inFlight ? <span className="mon-usage-est">&nbsp;({chip.inFlight})</span> : null}
      {chip.total ? <span className="mon-usage-est">&nbsp;· {chip.total}</span> : null}
      {chip.eta ? <span className="mon-usage-est">&nbsp;· {chip.eta}</span> : null}
    </span>
  );
}

function isRunNotFoundError(error: Error | undefined): boolean {
  if (error === undefined) return false;
  if ("status" in error && error.status === 404) return true;
  if (!("code" in error)) return false;
  return error.code === "RunNotFound" || error.code === "RUN_NOT_FOUND" || error.code === "NOT_FOUND";
}

export function RunSelectionState({
  runId,
  loading,
  error,
  onRetry,
  onReturnToRuns,
}: {
  runId: string;
  loading: boolean;
  error?: Error;
  onRetry: () => void | Promise<void>;
  onReturnToRuns: () => void;
}) {
  if (loading) {
    return (
      <div className="mon-empty" data-testid="monitor-run-loading" role="status">
        <div>Loading run…</div>
        <div className="mon-dim mon-mono">{runId}</div>
      </div>
    );
  }

  const missing = error === undefined || isRunNotFoundError(error);
  return (
    <div
      className="mon-empty"
      data-testid={missing ? "monitor-run-unavailable" : "monitor-run-query-error"}
      role={missing ? "status" : "alert"}
    >
      <div>{missing ? "Run unavailable." : "Couldn't load run."}</div>
      <div className="mon-dim mon-mono">{runId}</div>
      <div className="mon-dim">
        {missing ? "The requested run does not exist or is no longer available." : error?.message}
      </div>
      <div className="mon-empty-actions">
        <Button
          variant="outline"
          data-testid={missing ? "monitor-run-refresh" : "monitor-run-retry"}
          onClick={() => void onRetry()}
        >
          {missing ? "Refresh" : "Retry"}
        </Button>
        <Button variant="outline" data-testid="monitor-run-return" onClick={onReturnToRuns}>
          Return to runs
        </Button>
      </div>
    </div>
  );
}

function RunDetail({
  runId,
  scores,
  onResult,
  onReturnToRuns,
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
}: {
  runId: string;
  scores: RunScores;
  onResult: (kind: "ok" | "err", text: string) => void;
  onReturnToRuns: () => void;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode | undefined) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
}) {
  const runQuery = useGatewayRun(runId);
  const actions = useGatewayActions();
  // The monitor is an operator surface: system workflows' runs show here too,
  // so their UI lookup (Open UI / Create UI) must see them.
  const workflowsQuery = useGatewayWorkflows({ filter: { includeSystem: true } });
  // Task-vocabulary progress for the header (the health strip's counting).
  const detailTree = useGatewayRunTree(runId);
  // Event log remains a bounded live stream. Usage comes from its persisted,
  // full-run RPC so early attempts cannot fall out of the monitor's ring.
  const earlyStatus = isRecord(runQuery.data) ? asString(runQuery.data.status) : undefined;
  const usageLive = toneForStatus(earlyStatus) === "running" || toneForStatus(earlyStatus) === "waiting";
  const runEvents = useGatewayRunEvents(runId, { maxEvents: 500 });
  const runTokenUsage = useGatewayRunTokenUsage(runId, { refreshMs: usageLive ? 5_000 : undefined });
  const nodeStates = useNodeStates(runId, usageLive);
  const usageEvents = useMemo(() => runTokenUsage.data?.events ?? [], [runTokenUsage.data]);
  // Only the FIRST fetch gates render — background refetches keep showing the
  // retained data, so live polls never blank the chip, labels, or Usage panel.
  const usageLoading = runTokenUsage.data === undefined && runTokenUsage.loading;
  const usageFailed = runTokenUsage.data === undefined && runTokenUsage.error !== undefined;
  const usageTimings = useMemo(() => nodeTimingsOf(nodeStates.rows), [nodeStates.rows]);
  const [busyAction, setBusyAction] = useState<"cancel" | "resume" | "pause" | null>(null);
  const [showCustomUi, setShowCustomUi] = useState(false);
  const [creatingUi, setCreatingUi] = useState(false);
  const customUiDialogRef = useRef<HTMLDivElement | null>(null);
  const customUiReturnFocusRef = useRef<HTMLElement | null>(null);
  const workflowsRefetch = workflowsQuery.refetch;
  const closeCustomUi = () => {
    setShowCustomUi(false);
    queueMicrotask(() => customUiReturnFocusRef.current?.focus());
  };
  useEffect(() => {
    if (!showCustomUi) return;
    customUiDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCustomUi();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showCustomUi]);
  // While a create-ui run is authoring this workflow's UI, poll the workflow
  // list so the Open UI button appears the moment the file lands (the gateway
  // resolves .smithers/ui/<key>.tsx by convention with no restart).
  useEffect(() => {
    if (!creatingUi) return;
    const timer = setInterval(() => {
      void workflowsRefetch();
    }, 8_000);
    return () => clearInterval(timer);
  }, [creatingUi, workflowsRefetch]);

  const run = isRecord(runQuery.data) ? runQuery.data : null;

  if (!run || isRunNotFoundError(runQuery.error)) {
    return (
      <RunSelectionState
        runId={runId}
        loading={runQuery.loading}
        error={runQuery.error}
        onRetry={runQuery.refetch}
        onReturnToRuns={onReturnToRuns}
      />
    );
  }

  const status = asString(run.status);
  const workflowKey = asString(run.workflowKey) ?? "unknown";
  const startedAtMs =
    asNumber(pick(run, "startedAtMs", "started_at_ms")) ?? asNumber(pick(run, "createdAtMs", "created_at_ms"));
  const finishedAtMs = asNumber(pick(run, "finishedAtMs", "finished_at_ms"));
  const runState = isRecord(run.runState) ? run.runState : null;
  const healthState = runState ? asString(runState.state) : undefined;
  const quota = quotaInfoOf(run);
  const workflowRows = (Array.isArray(workflowsQuery.data) ? workflowsQuery.data : []).filter(isRecord);
  const workflowRow = workflowRows.find((row) => asString(row.key) === workflowKey);
  const customUiPath = workflowRow && workflowRow.hasUi === true ? asString(workflowRow.uiPath) : undefined;
  const customUiUrl = customUiPath ? `${customUiPath}?runId=${encodeURIComponent(runId)}` : undefined;
  const unhealthy =
    healthState !== undefined &&
    healthState !== labelForStatus(status) &&
    (healthState === "stale" || healthState === "orphaned" || healthState === "recovering");
  // ONE progress vocabulary: logical tasks (the health strip's counting),
  // never the node-state summary, which also counts structural container rows.
  // The summary only fills in while the tree is still loading.
  const taskProgress = taskProgressOf(detailTree.nodes ?? []);
  const progress = taskProgress ?? runProgress(run.summary);
  const runError = runErrorOf(run);
  const startedBy = startedByOf(run);

  const act = async (kind: "cancel" | "resume" | "pause") => {
    setBusyAction(kind);
    try {
      if (kind === "cancel") {
        await actions.cancelRun({ runId });
        onResult("ok", `Cancel requested for ${shortRunId(runId)}. The row updates when the engine confirms.`);
      } else if (kind === "pause") {
        // The gateway's pauseRun RPC (POST /v1/api/runs/:id/pause) is a
        // durable request: the engine stops scheduling, drains in-flight
        // tasks, then parks the run resumably. Not exposed on the actions
        // API, so call the REST route directly.
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/pause`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body: unknown = await response.json().catch(() => null);
        const envelope = isRecord(body) ? body : {};
        if (!response.ok || envelope.ok === false) {
          const error = isRecord(envelope.error) ? asString(envelope.error.message) : undefined;
          throw new Error(error ?? `pause failed (${response.status})`);
        }
        onResult(
          "ok",
          `Pause requested for ${shortRunId(runId)} — in-flight tasks drain, then the run parks resumably.`,
        );
      } else {
        await actions.resumeRun({ runId });
        onResult("ok", `Resume requested for ${shortRunId(runId)}.`);
      }
    } catch (error) {
      const verb = kind === "cancel" ? "Cancel" : kind === "pause" ? "Pause" : "Resume";
      onResult("err", `${verb} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="mon-detail" data-testid="monitor-run-detail">
      <header className="mon-detail-head mon-panel">
        <div className="mon-detail-title">
          <StatusTag status={status} />
          {unhealthy ? <StatusTag status={healthState} label={healthState} /> : null}
          <span className="mon-detail-workflow">{workflowKey}</span>
          {startedBy ? (
            <span
              className="mon-dim mon-mono"
              title={`Started by ${startedBy.harness ?? "unknown"}${startedBy.sessionId ? ` · ${startedBy.sessionId}` : ""}${startedBy.detected ? " · auto-detected" : ""}`}
              aria-label={`Started by ${startedBy.harness ?? "unknown"}${startedBy.sessionId ? ` ${startedBy.sessionId}` : ""}${startedBy.detected ? ", auto-detected" : ""}`}
            >
              Started by {startedBy.harness ?? startedBy.sessionId}
            </span>
          ) : null}
          <span className="mon-dim">
            <Elapsed startMs={startedAtMs} endMs={finishedAtMs} />
          </span>
        </div>
        <CopyableRunId runId={runId} />
        {progress ? (
          <div
            className="mon-progress"
            title={`${progress.done} done · ${progress.failed} failed · ${progress.total} tasks`}
          >
            <div className="mon-progress-track">
              <div className="mon-progress-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <span className="mon-dim mon-mono">
              {progress.done + progress.failed}/{progress.total} tasks
              {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
            </span>
          </div>
        ) : null}
        {usageLoading || usageFailed ? null : (
          <RunUsageChip
            events={usageEvents}
            timings={usageTimings}
            tree={detailTree.root as unknown as PredictionTreeNode | null}
            live={usageLive}
          />
        )}
        <div className="mon-detail-actions">
          {customUiUrl ? (
            <Button
              variant="outline"
              onClick={() => {
                customUiReturnFocusRef.current = document.activeElement as HTMLElement | null;
                setShowCustomUi(true);
              }}
              title={`Open this workflow's custom UI (${customUiPath})`}
            >
              Open UI
            </Button>
          ) : workflowRow && workflowKey !== "create-ui" ? (
            <Button
              variant="outline"
              disabled={creatingUi}
              title="Launch the create-ui workflow: one agent writes .smithers/ui/<key>.tsx and verifies it against this gateway"
              onClick={() => {
                setCreatingUi(true);
                void actions
                  .launchRun({
                    workflow: "create-ui",
                    input: { targetWorkflow: workflowKey, gatewayUrl: location.origin, exampleRunId: runId },
                  })
                  .then(() => {
                    onResult(
                      "ok",
                      `Creating a UI for ${workflowKey} — the Open UI button appears here when it's ready (a few minutes).`,
                    );
                  })
                  .catch((error) => {
                    setCreatingUi(false);
                    onResult(
                      "err",
                      `Create UI failed to launch: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  });
              }}
            >
              {creatingUi ? "Creating UI…" : "Create UI"}
            </Button>
          ) : null}
          <RunLifecycleControls
            runId={runId}
            resumable={isResumable(status)}
            pausable={isPausable(status)}
            cancellable={isCancellable(status)}
            busyAction={busyAction}
            onAction={(kind) => void act(kind)}
          />
        </div>
      </header>

      <HealthStrip
        runId={runId}
        status={status}
        healthState={healthState}
        quota={quota}
        runError={runError}
        onResult={onResult}
      />

      <ScoresPanel scores={scores} />

      {showCustomUi && customUiUrl ? (
        <div className="mon-modal-backdrop" onClick={closeCustomUi} data-testid="monitor-ui-modal">
          <div
            className="mon-modal"
            ref={customUiDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${workflowKey} custom UI`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mon-modal-head">
              <span className="mon-kicker">{workflowKey} UI</span>
              <Chip asChild>
                <a href={customUiUrl} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
              </Chip>
              <Chip onClick={closeCustomUi}>Close</Chip>
            </header>
            <iframe className="mon-modal-frame" src={customUiUrl} title={`${workflowKey} custom UI`} />
          </div>
        </div>
      ) : null}

      <ExecutionPanel
        runId={runId}
        live={usageLive}
        selectedNode={selectedNode}
        onSelectNode={onSelectNode}
        autoSelectNodeId={autoSelectNodeId}
        onAutoSelected={onAutoSelected}
        usageEvents={usageEvents}
        usageLoading={usageLoading}
        usageFailed={usageFailed}
        nodeStates={nodeStates}
        treeQuery={detailTree}
      />

      <EventLog runId={runId} eventsState={runEvents} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell.
// ---------------------------------------------------------------------------

/**
 * Inspector + the selected run's complete persisted token usage. The query
 * lives here so updates only re-render the open inspector column.
 */
function NodeInspectorWithUsage({
  runId,
  node,
  scores,
  onResult,
  onClose,
}: {
  runId: string;
  node: TreeNode;
  scores: RunScores;
  onResult: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}) {
  const nodeLive = toneForStatus(node.status) === "running" || toneForStatus(node.status) === "waiting";
  const usageState = useGatewayRunTokenUsage(runId, { refreshMs: nodeLive ? 5_000 : undefined });
  const usageEvents = useMemo(() => usageState.data?.events ?? [], [usageState.data]);
  return (
    <NodeInspector
      runId={runId}
      node={node}
      scores={scores}
      usageEvents={usageEvents}
      onResult={onResult}
      onClose={onClose}
    />
  );
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  // Selection is a KEY, not the node object: rows in the tree collection are
  // replaced as frames land, so a captured node would freeze the inspector at
  // click time (status/prompt/attempt stuck "running" forever). Deriving the
  // node from the live tree keeps every panel current.
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | undefined>(undefined);
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { status: connStatus } = useGatewayConnectionStatus();
  // No offset/cursor in the gateway's ListRunsRequest filter, so fetch a wide
  // window and let the landing table paginate client-side (RUNS_PAGE_SIZE).
  const runsQuery = useGatewayRuns({ filter: { limit: 1000 } });
  const allRuns = (runsQuery.data ?? []) as RunRow[];
  const [runsPage, setRunsPage] = useState(1);
  const selectedRun = allRuns.find((run) => run.runId === selectedRunId);
  const scores = useRunScores(selectedRunId, !isTerminalStatus(selectedRun?.status));
  const selectedTree = useGatewayRunTree(selectedRunId);
  const selectedNode = useMemo(() => {
    if (!selectedNodeKey) return undefined;
    // Find in the REBUILT tree (not the flat collection rows) so the inspector
    // keeps `children` — container detection and the child rollup need them.
    const stack: TreeNode[] = selectedTree.root ? [selectedTree.root as TreeNode] : [];
    while (stack.length > 0) {
      const candidate = stack.pop()!;
      if (treeNodeKey(candidate) === selectedNodeKey) return candidate;
      for (const child of (candidate.children ?? []) as TreeNode[]) stack.push(child);
    }
    return undefined;
  }, [selectedNodeKey, selectedTree.root]);

  // Resolve ?runId=&nodeId= once, when runs first arrive. An unknown id still
  // selects (RunDetail renders an honest "Run not found" state).
  const urlResolved = useRef(false);
  const initialNodeId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (urlResolved.current || (!monitorMode.runId && allRuns.length === 0)) return;
    urlResolved.current = true;
    if (monitorMode.runId) {
      setSelectedRunId(monitorMode.runId);
      initialNodeId.current = monitorMode.nodeId;
    }
  }, [allRuns.length]);

  const selectRun = (runId: string | undefined) => {
    setSelectedRunId(runId);
    setSelectedNodeKey(undefined);
    // Picking a run means "show me the run" — leave the metrics view.
    setShowMetrics(false);
    emitSelection(runId, undefined);
  };
  const selectNode = (node: TreeNode | undefined) => {
    setSelectedNodeKey(node ? treeNodeKey(node) : undefined);
    emitSelection(selectedRunId, node ? (node.id ?? treeNodeKey(node)) : undefined);
  };

  const showResult = (kind: "ok" | "err", text: string) => {
    setBanner({ kind, text });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    if (kind === "ok") bannerTimer.current = setTimeout(() => setBanner(null), 4000);
  };

  // The table's sort state lives here (not in the table) so the j/k keyboard
  // order below always matches the shown order; the cursor is the j/k row.
  const [tableSort, setTableSort] = useState<RunsTableSort>("default");
  const [cursorRunId, setCursorRunId] = useState<string | undefined>(undefined);
  const visibleRuns = useMemo(
    () => filterRuns(allRuns, { text: filterText, status: statusFilter, workflow: workflowFilter }),
    [allRuns, filterText, statusFilter, workflowFilter],
  );
  const resetFilters = () => {
    setFilterText("");
    setStatusFilter("all");
    setWorkflowFilter("all");
  };
  // A changed filter means a new result set: land back on its first page.
  useEffect(() => {
    setRunsPage(1);
    setCursorRunId(undefined);
  }, [filterText, statusFilter, workflowFilter]);
  const workflows = useMemo(() => workflowOptions(allRuns), [allRuns]);
  const statuses = useMemo(() => statusOptions(allRuns), [allRuns]);
  const inspectorOpen = !monitorMode.embed && selectedRunId !== undefined && selectedNode !== undefined;
  // The rail is a run switcher — it earns its place only next to a run. The
  // overview owns one run list (the table); two orders on one screen was noise.
  const railOpen = !monitorMode.embed && selectedRunId !== undefined;

  // Keyboard kit: `/` focuses search, j/k move the cursor (overview) or step
  // runs (run detail), Enter opens the cursor row, Esc backs out one level.
  const sortedTableRuns = useMemo(() => sortRunsForTable(visibleRuns, tableSort), [visibleRuns, tableSort]);
  const railOrderRuns = useMemo(() => groupRuns(visibleRuns).flatMap((group) => group.runs), [visibleRuns]);
  // The handler registers once and reads the latest snapshot from a ref —
  // re-registering a window listener per keystroke-relevant render churns.
  const keyState = useRef({
    selectedRunId,
    selectedNodeKey,
    sortedTableRuns,
    railOrderRuns,
    cursorRunId,
    selectNode,
    selectRun,
  });
  keyState.current = {
    selectedRunId,
    selectedNodeKey,
    sortedTableRuns,
    railOrderRuns,
    cursorRunId,
    selectNode,
    selectRun,
  };
  useEffect(() => {
    if (monitorMode.embed) return;
    const onKeyDown = createMonitorKeydownHandler(keyState, setCursorRunId, setRunsPage);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className={`mon-shell${monitorMode.embed ? " mon-embed" : ""}`} data-testid="monitor-root">
      <WorkflowUiStyles mode="theme" />
      <SmithersUiStyles extra={monitorCss} />
      {!monitorMode.embed ? (
        <header className="mon-topbar">
          <div className="mon-brand">
            <span className="mon-brand-mark" aria-hidden />
            <h1>Smithers Monitor</h1>
            <ConnectionBadge />
          </div>
          <MonitorToolbar
            filterText={filterText}
            onFilterText={setFilterText}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            statuses={statuses}
            workflowFilter={workflowFilter}
            onWorkflowFilter={setWorkflowFilter}
            workflows={workflows}
            visibleCount={visibleRuns.length}
            totalCount={allRuns.length}
            showMetrics={showMetrics}
            onToggleMetrics={() => setShowMetrics((value) => !value)}
            onRefresh={() => void runsQuery.refetch()}
          />
        </header>
      ) : null}

      {banner ? (
        <div className={`mon-banner mon-banner-app tone-${banner.kind === "ok" ? "ok" : "failed"}`} role="status">
          {banner.text}
          <Chip onClick={() => setBanner(null)}>Dismiss</Chip>
        </div>
      ) : null}

      <div className={`mon-body${inspectorOpen ? "" : " mon-body-no-inspector"}${railOpen ? "" : " mon-body-no-rail"}`}>
        {railOpen ? (
          <div className="mon-rail">
            <ApprovalsInbox onSelectRun={selectRun} onResult={showResult} />
            <RunsRail
              runs={visibleRuns}
              loading={runsQuery.loading ?? false}
              totalCount={allRuns.length}
              queryError={runsQuery.error}
              onResetFilters={resetFilters}
              onRetry={runsQuery.refetch}
              connStatus={connStatus}
              selectedRunId={selectedRunId}
              onSelect={selectRun}
            />
          </div>
        ) : null}

        <div className="mon-main">
          {showMetrics ? (
            <MetricsPanel />
          ) : selectedRunId ? (
            <RunDetail
              runId={selectedRunId}
              scores={scores}
              onResult={showResult}
              onReturnToRuns={() => selectRun(undefined)}
              selectedNode={selectedNode}
              onSelectNode={selectNode}
              autoSelectNodeId={initialNodeId.current}
              onAutoSelected={() => {
                initialNodeId.current = undefined;
              }}
            />
          ) : (
            <div className="mon-overview">
              {connStatus === "online" ? (
                <>
                  <NeedsYouBand
                    runs={allRuns}
                    loading={runsQuery.loading ?? false}
                    onSelectRun={selectRun}
                    onResult={showResult}
                  />
                  <ActiveNowBand runs={allRuns} onSelectRun={selectRun} />
                </>
              ) : null}
              <RunsTable
                runs={visibleRuns}
                loading={runsQuery.loading ?? false}
                totalCount={allRuns.length}
                queryError={runsQuery.error}
                connStatus={connStatus}
                hasCachedData={allRuns.length > 0}
                onResetFilters={resetFilters}
                onRetry={runsQuery.refetch}
                page={runsPage}
                onPageChange={setRunsPage}
                onSelect={selectRun}
                sort={tableSort}
                onSortChange={setTableSort}
                cursorRunId={cursorRunId}
              />
              {connStatus === "online" ? (
                <>
                  <CronsPanel />
                  <OpsFooter runs={allRuns} onShowMetrics={() => setShowMetrics(true)} />
                </>
              ) : null}
            </div>
          )}
        </div>

        {inspectorOpen ? (
          <>
            <div className="mon-inspector-backdrop" onClick={() => selectNode(undefined)} aria-hidden />
            <NodeInspectorWithUsage
              runId={selectedRunId!}
              node={selectedNode!}
              scores={scores}
              onResult={showResult}
              onClose={() => selectNode(undefined)}
            />
          </>
        ) : null}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Styles. Token-first on top of the shared workflow-UI theme (light by
// default, OS dark mode, `data-theme` override) — every color is a theme
// variable or a shared semantic soft/border token; tones carry state, never decoration.
//
// Controls (buttons, chips, inputs, selects, row buttons, tables) are the
// shared smthrs/ui primitives rendered by SmithersUiStyles at
// the root — their geometry, hover, focus-ring, and disabled styling live in
// that package, never here. This sheet only carries monitor layout plus
// monitor-specific accents on those primitives (.mon-btn-ok, .mon-toggle).
// Geometry for the rest comes from the token scales below: spacing --sp-*,
// type --fs-*/--lh-*, radius --r-*. No bare pixel values in spacing/radius/
// font-size rules.
// ---------------------------------------------------------------------------

export const monitorCss = `
/* Geometry, color, and elevation tokens come from the ui-styleguide theme
   (inlined by the gateway host page). Monitor-specific tokens only. */
:root {
  --panel-pad: var(--sp-4);
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: var(--fs-3); line-height: var(--lh-body); }
button, input, select { font: inherit; color: inherit; }
code { font-family: var(--font-mono); font-size: var(--fs-2); background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-1); padding: 0 var(--sp-1); }

.tone-running { --tone: var(--brand); --tone-soft: var(--brand-soft); --tone-border: var(--brand-border); }
.tone-ok { --tone: var(--ok); --tone-soft: var(--success-soft); --tone-border: var(--success-border); }
.tone-waiting { --tone: var(--warn); --tone-soft: var(--warning-soft); --tone-border: var(--warning-border); }
.tone-failed { --tone: var(--err); --tone-soft: var(--danger-soft); --tone-border: var(--danger-border); }
.tone-idle { --tone: var(--muted); --tone-soft: var(--hover-subtle); --tone-border: var(--border); }

.mon-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.mon-topbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border); flex-wrap: wrap; background: var(--surface-glass-strong); -webkit-backdrop-filter: blur(18px) saturate(180%); backdrop-filter: blur(18px) saturate(180%); }
.mon-brand { display: flex; align-items: center; gap: var(--sp-2); }
.mon-brand h1 { margin: 0; font-size: var(--fs-4); font-weight: 650; letter-spacing: -0.01em; }
.mon-brand-mark { width: 10px; height: 10px; border-radius: var(--r-full); background: var(--brand); box-shadow: 0 0 8px var(--brand-border); }
.mon-conn { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); font-weight: 600; color: var(--tone); }
.mon-conn-hint { color: var(--muted); font-weight: 400; }
.mon-conn .mon-chip { height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); margin-left: var(--sp-1); }
.mon-toolbar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-count-note { font-size: var(--fs-1); font-variant-numeric: tabular-nums; }

/* Controls are the shared smthrs/ui primitives (sui-*): Button,
   Input, Select, RowButton carry their own geometry, hover, focus ring, and
   disabled styling. Only monitor-specific accents live here. */
.mon-filter-input { min-width: 200px; }
.mon-btn-ok { color: var(--ok); border-color: var(--success-border); }
.mon-toggle { color: var(--muted); font-size: var(--fs-1); font-weight: 600; }
.mon-toggle.is-on { color: var(--brand); border-color: var(--brand-border); background: var(--brand-soft); }

/* Non-interactive label chips (agent names, #iteration, score chips). */
.mon-chip { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--muted); white-space: nowrap; }

.mon-kicker { margin: 0; font-size: var(--fs-1); line-height: var(--lh-tight); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.mon-kicker-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.mon-child-rollup { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.mon-child-stat { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); }
.mon-container-note { font-size: var(--fs-1); }
.mon-hijack-inline { flex: none; }
.mon-tree-xml { font-family: var(--font-mono); }
.mon-xml-row { display: flex; align-items: baseline; gap: 2px; line-height: 1.7; }
.mon-xml-row.is-active { background: var(--brand-soft); border-radius: var(--r-1); }
.mon-xml-open { display: inline; border: 0; background: none; padding: 0; margin: 0; cursor: pointer; font: inherit; text-align: left; color: inherit; }
.mon-xml-open:hover .mon-xml-tag { text-decoration: underline; }
.mon-xml-open:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-xml-punct { color: var(--dim); }
.mon-xml-tag { color: var(--brand); }
.mon-xml-attr-name { color: var(--muted); }
.mon-xml-str { color: var(--ok); }
.mon-xml-status { color: var(--tone, var(--ok)); }
.mon-xml-ellipsis { color: var(--muted); padding: 0 2px; }
.mon-count { font-variant-numeric: tabular-nums; color: var(--text); }
.mon-mono { font-family: var(--font-mono); font-size: var(--fs-1); }
.mon-dim { color: var(--muted); }

.mon-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone, var(--muted)); flex: none; }
.mon-dot-pulse { animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-pill { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; color: var(--tone); background: var(--tone-soft); border: 1px solid var(--tone-border); white-space: nowrap; }

/* Banners (app-level, health strip, inline errors) share one geometry. */
.mon-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin: 0 0 var(--sp-4); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-2); font-weight: 600; font-size: var(--fs-2); color: var(--tone); background: var(--tone-soft); border: 1px solid var(--tone-border); animation: mon-in 140ms ease-out; }
.mon-banner-app { margin: var(--sp-2) var(--sp-4) 0; }

.mon-body { display: grid; grid-template-columns: 320px minmax(420px, 1fr) minmax(0, 380px); flex: 1; overflow: hidden; }
/* No node selected: the inspector column collapses instead of reserving ~380px of dead gutter. */
.mon-body-no-inspector { grid-template-columns: 320px minmax(420px, 1fr); }
/* Overview: no rail (the table owns the run list), main takes the row. */
.mon-body-no-rail { grid-template-columns: minmax(420px, 1fr) minmax(0, 380px); }
.mon-body-no-rail.mon-body-no-inspector { grid-template-columns: minmax(0, 1fr); }
.mon-overview { max-width: 1160px; margin: 0 auto; width: 100%; }
.mon-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.mon-main { overflow-y: auto; padding: var(--sp-4); }
.mon-embed .mon-body { display: block; }
.mon-embed .mon-main { height: 100%; padding: var(--sp-4); }
.mon-embed .mon-inspector { display: none; }
.mon-inspector { border-left: 1px solid var(--border); overflow-y: auto; padding: var(--panel-pad); animation: mon-in 140ms ease-out; }
/* Click-outside-to-close backdrop — only visible in the overlay layout. */
.mon-inspector-backdrop { display: none; }
@media (max-width: 1160px) {
  .mon-body, .mon-body-no-inspector { grid-template-columns: 300px 1fr; }
  .mon-body-no-rail, .mon-body-no-rail.mon-body-no-inspector { grid-template-columns: minmax(0, 1fr); }
  .mon-inspector { position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 90vw); background: var(--bg); box-shadow: -12px 0 36px rgb(var(--shadow-rgb) / 0.14); z-index: 10; }
  .mon-inspector-backdrop { display: block; position: fixed; inset: 0; z-index: 9; background: rgb(var(--shadow-rgb) / 0.35); }
}

/* Phones trade the side-by-side rail for vertically stacked, independently
   scrollable panes. Keeping the shell itself clipped means wide tables and
   tree rows remain scrollable inside their owning panels instead of widening
   the document. */
@media (max-width: 720px) {
  .mon-topbar { align-items: flex-start; padding: var(--sp-3); }
  .mon-brand, .mon-toolbar { width: 100%; }
  .mon-toolbar { align-items: flex-start; }
  .mon-filter-input { flex: 1 1 100%; min-width: 0; }

  .mon-body { display: flex; flex-direction: column; min-height: 0; }
  .mon-rail { flex: 0 1 42%; min-height: 160px; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--sp-3); }
  .mon-main { flex: 1 1 auto; min-width: 0; min-height: 0; padding: var(--sp-3); }

  .mon-panel-head, .mon-detail-actions, .mon-progress, .mon-scrub { flex-wrap: wrap; }
  .mon-metrics-grid { grid-template-columns: minmax(0, 1fr); }
  .mon-modal-backdrop { padding: var(--sp-3); }
  .mon-modal { width: min(1280px, 100%); height: min(860px, 100%); }
}

.mon-inbox { border: 1px solid var(--warning-border); border-radius: var(--r-3); padding: var(--panel-pad); background: var(--warning-soft); animation: mon-in 140ms ease-out; }
.mon-inbox .mon-kicker { margin-bottom: var(--sp-1); }
.mon-approval { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) 0; border-top: 1px solid var(--border); }
.mon-approval:first-of-type { border-top: 0; }
.mon-approval:last-of-type { padding-bottom: 0; }
.mon-approval-main { text-align: left; background: none; border: 0; padding: 0; cursor: pointer; border-radius: var(--r-1); }
.mon-approval-main:hover .mon-approval-title { color: var(--brand); }
.mon-approval-main:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-approval-title { font-weight: 600; }
.mon-approval-meta { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
/* Agent-authored context is clamped to 3 lines — the question and its actions
   stay together above the fold; "more" expands in place. */
.mon-approval-summary-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 0; }
.mon-approval-summary { color: var(--muted); font-size: var(--fs-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
.mon-approval-summary.is-expanded { display: block; overflow: visible; }
.mon-approval-more { display: inline; background: none; border: 0; padding: 0; cursor: pointer; color: var(--brand); font-size: var(--fs-1); font-weight: 600; }
.mon-approval-more:hover { text-decoration: underline; }
.mon-approval-actions { display: flex; gap: var(--sp-2); }
.mon-approval-actions > * { flex: 1 1 0; justify-content: center; }
/* The decision is the reason the panel exists: Approve is the filled primary. */
.mon-btn-approve { color: var(--ok); font-weight: 700; }
.mon-wait { font-size: var(--fs-1); font-weight: 600; color: var(--tone); }

.mon-run-group { display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-run-group .mon-kicker { padding: 0 var(--sp-1) var(--sp-1); }
/* Rail rows are shared RowButtons; only the internal layout is monitor-specific. */
.mon-run-row { justify-content: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
.mon-run-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-run-when { margin-left: auto; font-size: var(--fs-1); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Landing runs table: fills the main column; the table body scrolls inside the
   panel (sticky header), never the page. */
.mon-runs-table-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; margin: 0; }
.mon-runs-table-panel .mon-panel-head { margin-bottom: var(--sp-2); }
.mon-runs-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-2); }
.mon-runs-scroll:focus-visible, .mon-tree:focus-visible, .mon-events:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--ring-border); }
/* The shared Table wraps itself in an overflow-x container; inside the
   monitor's scrollports that inner scroller would defeat the sticky header,
   so let the outer .mon-*-scroll own all scrolling. */
.mon-runs-scroll [data-slot="table-container"], .mon-crons-scroll [data-slot="table-container"] { overflow-x: visible; }
.mon-runs-table { font-size: var(--fs-2); }
.mon-runs-table th { position: sticky; top: 0; z-index: 1; background: var(--surface); white-space: nowrap; }
.mon-runs-table td { white-space: nowrap; font-variant-numeric: tabular-nums; }
.mon-runs-table tbody tr:last-child td { border-bottom: 0; }
.mon-runs-table-row { cursor: pointer; }
.mon-runs-table-row:hover { background: var(--hover); }
.mon-runs-table-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--ring-border); }
/* Workflow owns the row's identity: name first (middle-truncated so the
   distinguishing tail survives), the hex run id demoted to a secondary line. */
.mon-table-workflow { max-width: 0; width: 44%; overflow: hidden; text-overflow: ellipsis; }
.mon-table-workflow-name { font-weight: 600; }
.mon-runs-table-row:hover .mon-table-workflow-name { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.mon-table-runid { display: block; font-size: var(--fs-1); }
.mon-table-failed { color: var(--tone); font-weight: 600; }
.mon-th-sort { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; font-weight: inherit; }
.mon-th-sort:hover { color: var(--brand); }
.mon-sort-arrow { color: var(--brand); }
.mon-sort-note { font-size: var(--fs-1); }
.mon-runs-pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding-top: var(--sp-3); flex-wrap: wrap; }
.mon-runs-pagination-controls { display: inline-flex; align-items: center; gap: var(--sp-2); }

/* All panels share one padding, radius, and stacking rhythm. */
.mon-panel { border: 1px solid var(--border); border-radius: var(--r-3); background: var(--surface); box-shadow: var(--shadow-1); padding: var(--panel-pad); margin: 0 0 var(--sp-4); animation: mon-in 140ms ease-out; }
.mon-panel-head { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--ctl-h); margin-bottom: var(--sp-3); }
.mon-panel-head .mon-kicker { margin-right: auto; }

.mon-detail-head { display: flex; flex-direction: column; gap: var(--sp-2); }
.mon-detail-title { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-detail-workflow { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); letter-spacing: -0.01em; }
.mon-detail-actions { display: flex; gap: var(--sp-2); }
.mon-runid { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--muted); }
.mon-runid:hover { color: var(--text); }
.mon-runid:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-progress { display: flex; align-items: center; gap: var(--sp-2); }
.mon-progress-track { flex: 1; max-width: 320px; height: 5px; border-radius: var(--r-full); background: var(--brand-soft); overflow: hidden; }
.mon-progress-fill { height: 100%; border-radius: var(--r-full); background: var(--brand); transition: width 300ms ease; }

.mon-tree { overflow-x: auto; }
.mon-tree-row { display: flex; align-items: center; border-radius: var(--r-1); }
.mon-tree-row:hover { background: var(--hover); }
.mon-tree-row.is-active { background: var(--brand-soft); }
.mon-tree-chevron { width: 20px; flex: none; background: none; border: 0; cursor: pointer; color: var(--muted); text-align: center; }
.mon-tree-main { display: flex; align-items: center; gap: var(--sp-2); flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: var(--sp-1) var(--sp-2) var(--sp-1) 0; cursor: pointer; }
.mon-tree-chevron:focus-visible, .mon-tree-main:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-tree-glyph { flex: none; width: 14px; text-align: center; cursor: help; }
.mon-tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Containers (sequence/parallel/loop…) group tasks — they read quieter so
   the tree scans like a task list interrupted only where structure matters. */
.mon-tree-container .mon-tree-name { color: var(--muted); font-weight: 400; }
.mon-tree-duration { flex: none; margin-left: auto; font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
/* The status pill hugs the right edge — after the duration when one shows,
   self-aligned when it doesn't. */
.mon-tree-main .mon-pill { margin-left: auto; }
.mon-tree-duration ~ .mon-pill { margin-left: var(--sp-2); }
.mon-tree.is-static .mon-tree-main { cursor: default; }
.mon-tree.is-static { opacity: 0.92; }
.mon-tree-state { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; margin-bottom: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-2); color: var(--muted); background: var(--panel); font-size: var(--fs-1); }
.mon-tree-state-error { color: var(--err); border-color: var(--danger-border); background: var(--danger-soft); }
.mon-tree-state-actions { display: flex; align-items: center; gap: var(--sp-2); }

/* Measured vs estimated: estimates are always dim + italic + tilde-marked,
   measured numbers stay solid — the one rule across every usage surface. */
.mon-usage-est { color: var(--muted); font-style: italic; }
.mon-usage-chip { display: inline-flex; align-items: baseline; font-size: var(--fs-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Tree token labels sit beside the duration; alone they take the right edge. */
.mon-tree-tokens { flex: none; margin-left: auto; font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
.mon-tree-duration ~ .mon-tree-tokens { margin-left: var(--sp-2); }
.mon-tree-tokens ~ .mon-pill { margin-left: var(--sp-2); }

/* Usage panel: rate-limit bars show REMAINING quota, toned by headroom. */
.mon-usage-panel { display: flex; flex-direction: column; gap: var(--sp-4); }
.mon-usage-section { display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-usage-row { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) 0; font-size: var(--fs-2); }
.mon-usage-label { flex: 0 1 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.mon-usage-bar { flex: 1; min-width: 60px; height: 6px; border-radius: var(--r-full); background: var(--hover); overflow: hidden; }
.mon-usage-bar-fill { display: block; height: 100%; border-radius: var(--r-full); background: var(--tone, var(--brand)); }
.mon-usage-share-fill { background: var(--brand); }
.mon-usage-text { flex: none; min-width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
.mon-usage-reset { flex: none; min-width: 72px; text-align: right; font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
.mon-usage-shares { display: flex; flex-direction: column; }
.mon-spark { display: block; width: 100%; height: 28px; }
.mon-spark-bar { fill: var(--brand); opacity: 0.5; }
.mon-spark-now { opacity: 1; }
.mon-spark-legend { display: flex; justify-content: space-between; gap: var(--sp-2); margin-top: var(--sp-1); font-size: var(--fs-1); font-variant-numeric: tabular-nums; }

/* Node inspector: compact per-attempt usage breakdown under the Details grid. */
.mon-usage-attempts { display: flex; flex-direction: column; gap: 0; margin: calc(-1 * var(--sp-2)) 0 var(--sp-4); }
.mon-usage-attempt { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-1); }
.mon-usage-attempt:last-child { border-bottom: 0; }
.mon-usage-attempt-model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Timeline: one row per (nodeId, iteration), chronological, click to inspect. */
.mon-timeline { display: flex; flex-direction: column; overflow-y: auto; max-height: 60vh; }
.mon-timeline-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left; padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r-1); background: none; cursor: pointer; font-size: var(--fs-2); }
.mon-timeline-row:hover { background: var(--hover); }
.mon-timeline-row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-timeline-row.is-active { background: var(--brand-soft); box-shadow: inset 2px 0 0 var(--brand); }
.mon-timeline-node { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-timeline-row .mon-chip { flex: none; }
.mon-timeline-attempt { flex: none; }
.mon-timeline-right { display: flex; align-items: baseline; gap: var(--sp-3); margin-left: auto; flex: none; }
.mon-timeline-duration { font-variant-numeric: tabular-nums; }
.mon-timeline-when { font-size: var(--fs-1); font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }

/* Collapsed diff blocks: a one-line "N files, +X/−Y" summary; the syntax-
   colored diff view (@pierre/diffs) only mounts when expanded. */
.mon-diff { border: 1px solid var(--border); border-radius: var(--r-2); background: var(--panel); }
.mon-diff-summary { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); cursor: pointer; list-style: none; font-size: var(--fs-1); font-weight: 600; }
.mon-diff-summary::-webkit-details-marker { display: none; }
.mon-diff-summary:hover { background: var(--hover); border-radius: var(--r-2); }
.mon-diff-summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-diff-caret { color: var(--muted); transition: transform 120ms ease; }
.mon-diff[open] > .mon-diff-summary .mon-diff-caret { transform: rotate(90deg); }
.mon-diff[open] > .mon-diff-summary { border-bottom: 1px solid var(--border); border-radius: var(--r-2) var(--r-2) 0 0; }
.mon-diff-label { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-diff-stat { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mon-diff-view { max-height: 50vh; overflow: auto; padding: var(--sp-1); }
.mon-diff-raw { border: 0; }
.mon-diff-raw-note { font-size: var(--fs-1); padding: var(--sp-2) var(--sp-2) 0; }

.mon-scrub { display: flex; align-items: center; gap: var(--sp-2); padding: 0 0 var(--sp-3); }
.mon-scrub-range { flex: 1; min-width: 120px; accent-color: var(--brand); }
.mon-scrub-range:disabled { opacity: 0.45; }
.mon-scrub-note { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mon-scrub-loading { font-size: var(--fs-1); white-space: nowrap; animation: mon-pulse 1.2s ease-in-out infinite; }

.mon-events-panel { display: flex; flex-direction: column; }
.mon-events { max-height: 300px; overflow-y: auto; margin: 0; padding: 0; list-style: none; font-size: var(--fs-1); }
.mon-event { display: flex; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); align-items: baseline; }
.mon-event:last-child { border-bottom: 0; }
.mon-event-name { font-weight: 600; white-space: nowrap; }
.mon-event-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Relative time pins to the right edge so the log reads as a timed column. */
.mon-event-when { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
.mon-event-heartbeats { font-style: italic; }
.mon-liveness { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); white-space: nowrap; }

.mon-inspector-title { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); margin: var(--sp-1) 0 var(--sp-3); }
.mon-what { margin: 0 0 var(--sp-3); }
.mon-what-summary { white-space: pre-wrap; font-size: var(--fs-3); line-height: var(--lh-body); background: var(--brand-soft); border-radius: var(--r-1); padding: var(--sp-2) var(--sp-3); }
.mon-what-source { font-size: var(--fs-1); margin-top: var(--sp-1); }
.mon-inspector h3.mon-kicker { margin: var(--sp-4) 0 var(--sp-2); }
.mon-section { margin: var(--sp-4) 0 0; }
.mon-section-summary { display: flex; align-items: center; gap: var(--sp-2); cursor: pointer; list-style: none; user-select: none; border-radius: var(--r-1); }
.mon-section-summary::-webkit-details-marker { display: none; }
.mon-section-summary:hover .mon-section-title { color: var(--text); }
.mon-section-summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-section[open] > .mon-section-summary .mon-diff-caret { transform: rotate(90deg); }
.mon-section-title { transition: color 120ms ease; }
.mon-section-actions { margin-left: auto; }
.mon-section-body { margin-top: var(--sp-2); }
.mon-prompt { max-height: 30vh; }
.mon-meta-grid { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-1) var(--sp-3); align-items: baseline; margin: 0 0 var(--sp-4); }
.mon-meta-grid dt { color: var(--muted); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.mon-meta-grid dd { margin: 0; overflow-wrap: anywhere; }
.mon-toolcalls { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; }
.mon-toolcall { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--panel); }
.mon-output { margin: 0; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-2); background: var(--panel); font-size: var(--fs-1); line-height: var(--lh-body); white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto; max-height: 45vh; overflow-y: auto; }
.mon-output-fields { display: flex; flex-direction: column; gap: var(--sp-3); white-space: normal; }
.mon-output-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-output-field:has(.mon-output-scalar) { flex-direction: row; align-items: baseline; gap: var(--sp-2); }
.mon-output-key { color: var(--dim); font-size: var(--fs-1); flex: none; }
.mon-output-scalar { min-width: 0; overflow-wrap: anywhere; }
.mon-output-val { margin: 0; padding: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--bg); font-size: var(--fs-1); line-height: var(--lh-body); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow-y: auto; }
.mon-failure { border-color: var(--danger-border); }
.mon-live-output { max-height: 32vh; }
.mon-live-line { border-bottom: 1px dashed var(--border); overflow-wrap: anywhere; }
.mon-live-cmd { font-family: var(--font-mono); color: var(--text); }
.mon-live-text { }
.mon-live-meta { color: var(--muted); font-style: italic; }
.mon-live-pending { display: inline-flex; align-items: center; gap: var(--sp-2); }
.mon-live-line:last-child { border-bottom: 0; }
.mon-quota { flex-direction: column; align-items: flex-start; }
.mon-health { flex-direction: column; align-items: flex-start; gap: var(--sp-1); }
.mon-health-headline { display: flex; align-items: center; gap: var(--sp-2); }
.mon-health-actions { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2); }
.mon-health-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone); box-shadow: 0 0 6px var(--tone-border); }
.mon-health-detail { font-weight: 400; overflow-wrap: anywhere; }
.mon-health-fix { font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list li { overflow-wrap: anywhere; }
/* Inline approval gates: the decision lives in the banner that names it. */
.mon-health-approval { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; width: 100%; padding: var(--sp-2) 0; border-top: 1px solid var(--tone-border); }
.mon-health-approval-title { font-weight: 600; }
.mon-health-approval .mon-approval-actions { margin-left: auto; flex: none; min-width: 220px; }
.mon-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgb(var(--shadow-rgb) / 0.55); display: flex; align-items: center; justify-content: center; padding: var(--sp-6); }
.mon-modal { width: min(1280px, 96vw); height: min(860px, 92vh); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; box-shadow: 0 18px 60px rgb(var(--shadow-rgb) / 0.45); }
.mon-modal-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
.mon-modal-head .mon-kicker { flex: 1; }
.mon-modal-frame { flex: 1; border: 0; width: 100%; background: var(--bg); }

/* PTY hand-off: the shared <OneshotSurface> owns the terminal and its chrome;
   the monitor only sizes and themes the panel it renders into. */
.mon-hijack-surface { padding: var(--sp-2) var(--sp-3); background: var(--surface); color: var(--text); outline-color: var(--ring-border); }

.mon-empty { color: var(--muted); text-align: center; padding: var(--sp-6) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-empty-actions { display: flex; justify-content: center; gap: var(--sp-2); margin-top: var(--sp-3); }
.mon-empty-hero { padding-top: 18vh; }

/* Workspace overview: ops strip above the runs table, crons panel below.
   The runs table keeps the scrollable middle; the strip and crons are fixed. */
.mon-overview { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.mon-overview .mon-runs-table-panel { flex: 1; min-height: 200px; }
/* "Needs you" band: the only colored surface on the overview. */
.mon-needs { margin: 0 0 var(--sp-4); }
.mon-needs-clear { display: flex; align-items: center; gap: var(--sp-2); border: 1px solid var(--success-border); border-radius: var(--r-3); padding: var(--sp-3) var(--panel-pad); background: var(--success-soft); color: var(--ok); font-weight: 600; }
.mon-needs-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) 0; border-top: 1px solid var(--border); background: none; border-left: 0; border-right: 0; border-bottom: 0; cursor: pointer; text-align: left; font: inherit; color: inherit; }
.mon-needs-row:hover .mon-needs-name { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.mon-needs-row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-needs-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-needs-when { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; }
.mon-needs-more { font-size: var(--fs-1); padding: var(--sp-1) 0; }

/* "Active now" band: one rich row per live run. */
.mon-active-band { margin: 0 0 var(--sp-4); }
.mon-active-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: var(--sp-2) 0; border-top: 1px solid var(--border); background: none; border-left: 0; border-right: 0; border-bottom: 0; cursor: pointer; text-align: left; font: inherit; color: inherit; }
.mon-active-row:first-of-type { border-top: 0; }
.mon-active-row:hover .mon-active-name { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.mon-active-row:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-active-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-active-progress { flex: 1 1 220px; min-width: 120px; display: flex; justify-content: flex-end; }
.mon-active-elapsed { flex: none; min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }

/* Ops footer: the demoted stat tiles — one quiet line under everything. */
.mon-ops-footer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); padding: var(--sp-3) 0 0; margin-top: var(--sp-4); border-top: 1px solid var(--border); font-size: var(--fs-1); }
.mon-ops-footer-item { white-space: nowrap; }
.mon-ops-footer-link { background: none; border: 0; padding: 0; cursor: pointer; color: var(--brand); font: inherit; font-weight: 600; }
.mon-ops-footer-link:hover { text-decoration: underline; }

/* Keyboard cursor (j/k): distinct from hover so both can coexist. */
.mon-runs-table-row.is-kbcursor { background: var(--hover); box-shadow: inset 2px 0 0 var(--brand); }

.mon-ops-strip { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0 0 var(--sp-4); }
.mon-stat { flex: 1 1 120px; min-width: 0; max-width: 240px; border: 1px solid var(--border); border-radius: var(--r-2); background: var(--surface); box-shadow: var(--shadow-1); padding: var(--sp-3) var(--sp-3); }
.mon-stat-value { font-size: var(--fs-6); font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; line-height: var(--lh-tight); color: var(--tone, var(--text)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Labels and subs wrap to two lines before ever clipping mid-word — the value
   carries the glance, the label must stay readable. */
.mon-stat-label { font-size: var(--fs-1); font-weight: 650; text-transform: uppercase; letter-spacing: 0.05em; line-height: var(--lh-tight); color: var(--muted); margin-top: var(--sp-1); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mon-stat-sub { font-size: var(--fs-1); color: var(--muted); line-height: var(--lh-tight); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* Crons panel: fixed below the table; its own horizontal scroll if narrow. */
.mon-crons-panel { margin: var(--sp-4) 0 0; flex: none; }
.mon-crons-scroll { overflow: auto; max-height: 32vh; border: 1px solid var(--border); border-radius: var(--r-2); }
.mon-cron-error { max-width: 320px; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-1); }

/* Scores: run panel rows + inspector chips share the tone system. */
.mon-scores-panel .mon-panel-head { margin-bottom: var(--sp-2); }
.mon-scores-list { display: flex; flex-direction: column; }
.mon-score-row { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-2); }
.mon-score-row:last-child { border-bottom: 0; }
.mon-score-pill { flex: none; }
.mon-score-name { font-weight: 600; white-space: nowrap; }
.mon-score-node { flex: none; overflow: hidden; text-overflow: ellipsis; max-width: 220px; white-space: nowrap; }
.mon-score-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mon-scores-details > .mon-scores-summary { display: flex; align-items: center; gap: var(--sp-2); cursor: pointer; list-style: none; font-size: var(--fs-2); font-weight: 600; padding: var(--sp-1) 0; }
.mon-scores-summary::-webkit-details-marker { display: none; }
.mon-scores-summary:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--ring); }
.mon-scores-details[open] > .mon-scores-summary .mon-diff-caret { transform: rotate(90deg); }
.mon-node-scores { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin: 0 0 var(--sp-3); }
.mon-score-chip { color: var(--tone); border-color: var(--tone-border); background: var(--tone-soft); }

/* Metrics view: sections of label/value rows, monospace numbers. */
.mon-metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sp-4) var(--sp-6); }
.mon-metrics-section .mon-kicker { margin: 0 0 var(--sp-2); }
.mon-metrics-table { display: flex; flex-direction: column; }
.mon-metric-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-2); }
.mon-metric-row:last-child { border-bottom: 0; }
.mon-metric-head { color: var(--muted); font-size: var(--fs-1); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.mon-metric-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mon-metric-label.tone-ok, .mon-metric-value.tone-ok { color: var(--ok); }
.mon-metric-label.tone-failed, .mon-metric-value.tone-failed { color: var(--err); }
.mon-metric-value { font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }

/* Overview has three deliberate layouts: a persistent rail on desktop, a
   narrower rail beside the table on tablet, and vertically stacked controls,
   rail, and table on phones. The table keeps its own horizontal scrollport
   at the smallest width so the shell itself never needs to overflow. */
@media (max-width: 760px) {
  .mon-shell { height: auto; min-height: 100vh; overflow: visible; }
  .mon-topbar { align-items: stretch; padding: var(--sp-3); }
  .mon-brand { flex-wrap: wrap; }
  .mon-toolbar { width: 100%; }
  .mon-filter-input { flex: 1 1 100%; min-width: 0; }
  .mon-toolbar [data-slot="select-trigger"] { flex: 1 1 140px; min-width: 0; }
  .mon-body { display: block; overflow: visible; }
  .mon-rail { max-height: 30vh; overflow-y: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: var(--sp-3); }
  .mon-main { overflow: visible; padding: var(--sp-3); }
  .mon-overview { height: auto; }
  .mon-overview .mon-runs-table-panel { min-height: 320px; }
  .mon-runs-scroll { overflow: auto; }
  .mon-runs-pagination { align-items: flex-start; }
  .mon-runs-pagination-controls { flex-wrap: wrap; }
  .mon-crons-panel { max-width: 100%; }
}

@keyframes mon-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;

if (typeof document !== "undefined" && monitorMode.theme) {
  document.documentElement.dataset.theme = monitorMode.theme;
}

if (typeof document !== "undefined" && document.getElementById("root")) {
  createGatewayReactRoot(<App />);
}
