/** @jsxImportSource react */
/**
 * The Smithers Monitor — a live web UI over every run in the workspace.
 *
 * Served by the gateway at /monitor (mounted by `smithers gateway`, opened by
 * `smithers monitor`). Purely an observer: it launches nothing, everything on
 * screen is live gateway state. Domain logic lives in ./monitorModel.ts.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  useGatewayWorkflows,
} from "smithers-orchestrator/gateway-react";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "smithers-orchestrator/gateway-client";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import type { Terminal as XTerminal, IDisposable } from "@xterm/xterm";
// Inlined at bundle time (Bun.build) — the gateway serves one self-contained
// client.js, so the stylesheet ships as a string appended to monitorCss.
import xtermCss from "@xterm/xterm/css/xterm.css" with { type: "text" };
import {
  asArray,
  asNumber,
  asString,
  autoExpandKeys,
  clampFrameNo,
  diagnoseRun,
  eventViewFor,
  filterRuns,
  formatElapsed,
  formatEventLine,
  formatOutputValue,
  frameScrubBounds,
  groupRuns,
  hasFailedDescendant,
  hijackActionFor,
  hijackCandidateForNode,
  hijackCandidatesOf,
  isCancellable,
  isRecord,
  isResumable,
  labelForStatus,
  nodeErrorOf,
  nodeSummaryEligible,
  paginateRuns,
  pick,
  ptyHijackUrl,
  quotaInfoOf,
  rowOf,
  runProgress,
  RUNS_PAGE_SIZE,
  shortRunId,
  statusOptions,
  timeAgo,
  toneForStatus,
  treeNodeKey,
  waitTone,
  workflowOptions,
  type HijackCandidate,
  type RunRow,
  type Tone,
  type TreeNodeLike,
} from "./monitorModel.ts";

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
  return useSyncExternalStore(subscribeClock, () => clockNowMs, () => clockNowMs);
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
  return <>in {mins}m {String(secs).padStart(2, "0")}s</>;
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

function StatusTag({ status, label }: { status: string | undefined; label?: string }) {
  const tone = toneForStatus(status);
  return (
    <span className={`mon-pill tone-${tone}`} data-status={labelForStatus(status)}>
      <span className={`mon-dot${tone === "running" ? " mon-dot-pulse" : ""}`} aria-hidden />
      {label ?? labelForStatus(status)}
    </span>
  );
}

function ToneDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span className={`mon-dot tone-${tone}${pulse ? " mon-dot-pulse" : ""}`} aria-hidden />;
}

/**
 * Transport truth readout — a status, not a control. "Live" only when the
 * gateway link is really streaming; degraded states name themselves.
 */
function ConnectionBadge() {
  const { status } = useGatewayConnectionStatus();
  const view: Record<string, { label: string; tone: Tone }> = {
    online: { label: "Live", tone: "ok" },
    connecting: { label: "Connecting…", tone: "waiting" },
    idle: { label: "Connecting…", tone: "waiting" },
    offline: { label: "Offline — showing last-known data", tone: "failed" },
    unauthorized: { label: "Unauthorized", tone: "failed" },
  };
  const { label, tone } = view[status] ?? { label: status, tone: "idle" as Tone };
  return (
    <span className={`mon-conn tone-${tone}`} data-testid="monitor-conn" data-conn={status}>
      <ToneDot tone={tone} pulse={tone === "ok"} />
      {label}
    </span>
  );
}

function CopyableRunId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
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

// ---------------------------------------------------------------------------
// URL deep links: ?runId=…&nodeId=… (replaceState keeps links shareable
// without polluting history).
// ---------------------------------------------------------------------------

function readUrlSelection(): { runId?: string; nodeId?: string } {
  if (typeof location === "undefined") return {};
  const params = new URLSearchParams(location.search);
  return { runId: params.get("runId") ?? undefined, nodeId: params.get("nodeId") ?? undefined };
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

function ApprovalsInbox({
  onSelectRun,
  onResult,
}: {
  onSelectRun: (runId: string) => void;
  onResult: (kind: "ok" | "err", text: string) => void;
}) {
  const approvalsQuery = useGatewayApprovals();
  const actions = useGatewayActions();
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const approvals = (approvalsQuery.data ?? []) as ApprovalLike[];
  if (approvals.length === 0) return null;

  const decide = async (approval: ApprovalLike, approved: boolean) => {
    if (!approved && !window.confirm(`Deny "${approval.requestTitle ?? approval.nodeId}"? This fails the waiting gate.`)) {
      return;
    }
    const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
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
      await approvalsQuery.refetch();
    } finally {
      setDecidingKey(null);
    }
  };

  return (
    <section className="mon-inbox" data-testid="monitor-approvals">
      <h2 className="mon-kicker">
        Approvals <span className="mon-count">{approvals.length}</span>
      </h2>
      {approvals.map((approval) => {
        const key = `${approval.runId}:${approval.nodeId}:${approval.iteration ?? 0}`;
        const busy = decidingKey === key;
        return (
          <div className="mon-approval" key={key}>
            <button type="button" className="mon-approval-main" onClick={() => onSelectRun(approval.runId)}>
              <div className="mon-approval-title">{approval.requestTitle ?? approval.nodeId}</div>
              <div className="mon-approval-meta">
                <span className="mon-mono">{approval.workflowKey ?? "workflow"}</span>
                <span className="mon-mono mon-dim">{shortRunId(approval.runId)}</span>
                <ApprovalWait requestedAtMs={approval.requestedAtMs} />
              </div>
              {approval.requestSummary ? <div className="mon-approval-summary">{approval.requestSummary}</div> : null}
            </button>
            <div className="mon-approval-actions">
              <button
                type="button"
                className="mon-btn mon-btn-ok"
                disabled={busy}
                onClick={() => void decide(approval, true)}
              >
                Approve
              </button>
              <button
                type="button"
                className="mon-btn mon-btn-danger"
                disabled={busy}
                onClick={() => void decide(approval, false)}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Runs rail.
// ---------------------------------------------------------------------------

function RunListRow({
  run,
  active,
  onSelect,
}: {
  run: RunRow;
  active: boolean;
  onSelect: (runId: string) => void;
}) {
  const tone = toneForStatus(run.status);
  const live = tone === "running" || tone === "waiting";
  return (
    <button
      type="button"
      className={`mon-run-row${active ? " is-active" : ""}`}
      data-testid="monitor-run-row"
      data-run-id={run.runId}
      onClick={() => onSelect(run.runId)}
    >
      <ToneDot tone={tone} pulse={tone === "running"} />
      <span className="mon-run-name" title={run.workflowKey ?? "unknown workflow"}>
        {run.workflowKey ?? "unknown"}
      </span>
      <span className="mon-mono mon-dim">{shortRunId(run.runId)}</span>
      <span className="mon-run-when mon-dim">
        {live ? <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={undefined} /> : <Ago ms={run.createdAtMs} />}
      </span>
    </button>
  );
}

function RunsRail({
  runs,
  loading,
  offline,
  selectedRunId,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  offline: boolean;
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}) {
  const groups = groupRuns(runs);
  return (
    <nav className="mon-rail-runs" data-testid="monitor-runs">
      {offline && runs.length === 0 ? (
        <div className="mon-banner tone-failed" data-testid="monitor-runs-offline">
          <div>Can't reach the Smithers gateway.</div>
          <div className="mon-dim">
            This tab's gateway isn't responding — it may have been restarted on another port. The page recovers
            automatically once it's back; otherwise re-open with <code>smithers monitor</code>.
          </div>
        </div>
      ) : null}
      {!offline && loading && runs.length === 0 ? <div className="mon-empty">Loading runs…</div> : null}
      {!offline && !loading && runs.length === 0 ? (
        <div className="mon-empty" data-testid="monitor-empty">
          <div>No runs match.</div>
          <div className="mon-dim">
            Launch one with <code>smithers up &lt;workflow&gt;</code> or <code>smithers workflow run &lt;id&gt;</code>.
          </div>
        </div>
      ) : null}
      {groups.map((group) => (
        <section key={group.group} className="mon-run-group">
          <h2 className="mon-kicker">
            {group.title} <span className="mon-count">{group.runs.length}</span>
          </h2>
          {group.runs.map((run) => (
            <RunListRow key={run.runId} run={run} active={run.runId === selectedRunId} onSelect={onSelect} />
          ))}
        </section>
      ))}
    </nav>
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
function RunProgressCell({ run }: { run: RunRow }) {
  const progress = isRecord(run) ? runProgress(run.summary) : null;
  if (!progress) return <span className="mon-dim">—</span>;
  return (
    <span className="mon-mono" title={`${progress.done} done · ${progress.failed} failed · ${progress.total} nodes`}>
      {progress.done + progress.failed}/{progress.total}
      {progress.failed > 0 ? <span className="tone-failed mon-table-failed"> · {progress.failed} failed</span> : null}
    </span>
  );
}

function RunsTable({
  runs,
  loading,
  page,
  onPageChange,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onSelect: (runId: string) => void;
}) {
  const { pageRows, page: shownPage, pageCount, total } = paginateRuns(runs, page, RUNS_PAGE_SIZE);
  if (total === 0) {
    return (
      <div className="mon-empty mon-empty-hero" data-testid="monitor-empty-detail">
        <div>{loading ? "Loading runs…" : "No runs match."}</div>
        <div className="mon-dim">
          {loading ? (
            "Live status, execution tree, node outputs, events, and approvals — for every run this gateway owns."
          ) : (
            <>
              Launch one with <code>smithers up &lt;workflow&gt;</code> or <code>smithers workflow run &lt;id&gt;</code>.
            </>
          )}
        </div>
      </div>
    );
  }
  const firstRow = (shownPage - 1) * RUNS_PAGE_SIZE + 1;
  const lastRow = Math.min(shownPage * RUNS_PAGE_SIZE, total);
  return (
    <section className="mon-panel mon-runs-table-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          All runs <span className="mon-count">{total}</span>
        </h2>
      </header>
      <div className="mon-runs-scroll">
        <table className="mon-runs-table" data-testid="monitor-runs-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Run</th>
              <th scope="col">Workflow</th>
              <th scope="col">Progress</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((run) => (
              <tr
                key={run.runId}
                className="mon-runs-table-row"
                data-run-id={run.runId}
                onClick={() => onSelect(run.runId)}
              >
                <td>
                  <StatusTag status={run.status} />
                </td>
                <td className="mon-mono">{shortRunId(run.runId)}</td>
                <td className="mon-table-workflow" title={run.workflowKey ?? "unknown workflow"}>
                  {run.workflowKey ?? "unknown"}
                </td>
                <td>
                  <RunProgressCell run={run} />
                </td>
                <td className="mon-dim">
                  <Ago ms={run.startedAtMs ?? run.createdAtMs} />
                </td>
                <td className="mon-dim mon-mono">
                  <Elapsed startMs={run.startedAtMs ?? run.createdAtMs} endMs={run.finishedAtMs} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="mon-runs-pagination" data-testid="monitor-runs-pagination">
        <span className="mon-dim mon-count-note">
          Showing {firstRow}–{lastRow} of {total}
        </span>
        <span className="mon-runs-pagination-controls">
          <button
            type="button"
            className="mon-btn"
            disabled={shownPage <= 1}
            onClick={() => onPageChange(shownPage - 1)}
          >
            Prev
          </button>
          <span className="mon-dim mon-count-note">
            Page {shownPage} / {pageCount}
          </span>
          <button
            type="button"
            className="mon-btn"
            disabled={shownPage >= pageCount}
            onClick={() => onPageChange(shownPage + 1)}
          >
            Next
          </button>
        </span>
      </footer>
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
          <button type="button" className="mon-tree-chevron" onClick={() => onToggle(key)} aria-label="Toggle">
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

function TreeRow({
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
  const glyph = KIND_GLYPHS[(node.kind ?? "").toLowerCase()] ?? "○";
  const agentName = isRecord(node.agent) ? asString(node.agent.name) : asString(node.agent);
  const failedBelow = !expanded && hasFailedDescendant(node);
  return (
    <>
      <div
        className={`mon-tree-row${key === selectedNodeKey ? " is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        role="treeitem"
        aria-expanded={children.length > 0 ? expanded : undefined}
      >
        {children.length > 0 ? (
          <button type="button" className="mon-tree-chevron" onClick={() => onToggle(key)} aria-label="Toggle">
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
          <span className="mon-tree-glyph mon-dim" aria-hidden>
            {glyph}
          </span>
          <span className="mon-tree-name">{node.cardLabel ?? node.name ?? node.id ?? key}</span>
          {agentName ? <span className="mon-chip">{agentName}</span> : null}
          {typeof node.iteration === "number" && node.iteration > 0 ? (
            <span className="mon-chip mon-dim">#{node.iteration}</span>
          ) : null}
          {failedBelow ? <ToneDot tone="failed" /> : null}
          <StatusTag status={node.status} />
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
              onToggle={onToggle}
              onSelect={onSelect}
              selectDisabled={selectDisabled}
            />
          ))
        : null}
    </>
  );
}

function ExecutionTree({
  runId,
  selectedNodeKey,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
  frameOverride,
  asXml,
}: {
  runId: string;
  selectedNodeKey: string | undefined;
  onSelectNode: (node: TreeNode) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
  /**
   * Frame-scrubber override: when set, render this static tree instead of the
   * live one and disable node selection. `root: null` means the frame maps to
   * an empty tree; `loading` keeps the empty state honest while a frame fetch
   * is in flight. Absent = live mode, unchanged.
   */
  frameOverride?: { root: TreeNode | null; loading: boolean };
  /** Render the tree as engine-style XML instead of expandable rows. */
  asXml?: boolean;
}) {
  const { root: liveRoot, nodes, isLoading, error } = useGatewayRunTree(runId);
  const isStatic = frameOverride !== undefined;
  const root = isStatic ? frameOverride.root : (liveRoot as TreeNode | null);
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
      <div className="mon-empty">
        Failed to load the execution tree. <span className="mon-dim">{error.message}</span>
      </div>
    );
  }
  if (!isStatic && isLoading) return <div className="mon-empty">Loading execution tree…</div>;
  if (!root) {
    return (
      <div className="mon-empty">
        {isStatic ? (frameOverride.loading ? "Loading frame…" : "No nodes in this frame.") : "No nodes recorded yet."}
      </div>
    );
  }
  if (asXml) {
    return (
      <div role="tree" className={`mon-tree mon-tree-xml${isStatic ? " is-static" : ""}`} data-testid="monitor-tree-xml">
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
    );
  }
  return (
    <div role="tree" className={`mon-tree${isStatic ? " is-static" : ""}`} data-testid="monitor-tree">
      <TreeRow
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
  );
}

// ---------------------------------------------------------------------------
// Execution panel with a frame-by-frame scrubber (time-travel view). The
// "Frames" chip toggles scrub mode: prev/next buttons and a range input over
// the run's committed frames fetch getDevToolsSnapshot({ runId, frameNo }) and
// render THAT tree statically (via snapshotToGatewayRunNode) instead of the
// live one; "Live" (or toggling the chip off) returns to the live tree.
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
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
}: {
  runId: string;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode | undefined) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
}) {
  const [scrubbing, setScrubbing] = useState(false);
  // null = pinned to the latest frame until the user actually scrubs.
  const [frame, setFrame] = useState<number | null>(null);
  const [asXml, setAsXml] = useState(false);
  // Reset scrub state when switching runs.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    if (scrubbing) setScrubbing(false);
    if (frame !== null) setFrame(null);
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
  const scrubLoading =
    scrubbing && (latestQuery.loading || frameQuery.loading || debouncedFrame !== shownFrame);
  const scrubError = scrubbing ? (latestQuery.error ?? frameQuery.error) : undefined;
  const goLive = () => {
    setScrubbing(false);
    setFrame(null);
  };
  const step = (delta: number) => {
    if (latestFrameNo === undefined) return;
    setFrame(clampFrameNo(shownFrame + delta, latestFrameNo));
  };
  return (
    <section className="mon-panel mon-tree-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Execution</h2>
        {selectedNode && !scrubbing ? (
          <button type="button" className="mon-chip" onClick={() => onSelectNode(undefined)}>
            Clear selection
          </button>
        ) : null}
        <button
          type="button"
          className={`mon-chip${scrubbing ? " is-on" : ""}`}
          data-testid="monitor-frames-chip"
          onClick={() => (scrubbing ? goLive() : setScrubbing(true))}
          title="Scrub the execution tree frame by frame instead of following it live"
        >
          Frames
        </button>
        <button
          type="button"
          className={`mon-chip${asXml ? " is-on" : ""}`}
          data-testid="monitor-xml-chip"
          onClick={() => setAsXml((value) => !value)}
          title="Toggle between the expandable tree and the engine's XML view of the same nodes"
        >
          XML
        </button>
      </header>
      {scrubbing ? (
        <div className="mon-scrub" data-testid="monitor-scrub">
          <button
            type="button"
            className="mon-chip"
            onClick={() => step(-1)}
            disabled={latestFrameNo === undefined || shownFrame <= bounds.min}
            aria-label="Previous frame"
          >
            ◀
          </button>
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
          <button
            type="button"
            className="mon-chip"
            onClick={() => step(1)}
            disabled={latestFrameNo === undefined || shownFrame >= bounds.max}
            aria-label="Next frame"
          >
            ▶
          </button>
          <span className="mon-mono mon-dim mon-scrub-note">
            frame {latestFrameNo === undefined ? "… / …" : `${shownFrame} / ${bounds.max}`}
          </span>
          {scrubLoading ? <span className="mon-dim mon-scrub-loading">loading…</span> : null}
          {scrubError && !scrubLoading ? (
            <span className="mon-dim mon-scrub-note" title={scrubError.message}>
              frame unavailable
            </span>
          ) : null}
          <button type="button" className="mon-chip" onClick={goLive} title="Return to the live tree">
            Live
          </button>
        </div>
      ) : null}
      <ExecutionTree
        runId={runId}
        selectedNodeKey={selectedNode ? treeNodeKey(selectedNode) : undefined}
        onSelectNode={onSelectNode}
        autoSelectNodeId={autoSelectNodeId}
        onAutoSelected={onAutoSelected}
        frameOverride={scrubbing ? { root: scrubTree, loading: scrubLoading } : undefined}
        asXml={asXml}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live event log with follow mode: auto-scrolls while you stay near the
// bottom; scrolling up pauses following; the Follow chip re-engages it.
// ---------------------------------------------------------------------------

const FOLLOW_THRESHOLD_PX = 80;

type EventView = "notable" | "activity" | "all";

function EventLog({ runId }: { runId: string }) {
  const { events: allEvents, streaming, error, loading } = useGatewayRunEvents(runId, { maxEvents: 500 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  // Default to Activity: lifecycle transitions plus the agent's visible work
  // (tool calls, chat output, frames, token usage). Heartbeats and session
  // bookkeeping stay one click away instead of drowning the log.
  const [view, setView] = useState<EventView>("activity");
  const events = useMemo(() => {
    if (view === "all") return allEvents;
    return allEvents.filter((frame) => {
      const kind = eventViewFor(asString(frame.event) ?? "");
      return view === "notable" ? kind === "notable" : kind !== "chatter";
    });
  }, [allEvents, view]);

  useEffect(() => {
    if (!following) return;
    const el = containerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [events.length, following, runId]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    setFollowing(nearBottom);
  };

  return (
    <section className="mon-panel mon-events-panel">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">
          Events <span className="mon-count">{events.length}{view === "all" ? "" : `/${allEvents.length}`}</span>
        </h2>
        <button
          type="button"
          className={`mon-chip${view === "notable" ? " is-on" : ""}`}
          onClick={() => setView("notable")}
          title="Node/run lifecycle, approvals, human requests"
        >
          Notable
        </button>
        <button
          type="button"
          className={`mon-chip${view === "activity" ? " is-on" : ""}`}
          onClick={() => setView("activity")}
          title="Notable plus tool calls, agent output, frames, and token usage"
        >
          Activity
        </button>
        <button
          type="button"
          className={`mon-chip${view === "all" ? " is-on" : ""}`}
          onClick={() => setView("all")}
          title="Every event, including heartbeats and session bookkeeping"
        >
          All
        </button>
        <button
          type="button"
          className={`mon-chip mon-follow${following ? " is-on" : ""}`}
          onClick={() => {
            setFollowing(true);
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          title="Auto-scroll to new events"
        >
          {streaming ? "● " : ""}Follow
        </button>
      </header>
      {error ? <div className="mon-banner tone-failed">{error.message}</div> : null}
      <div className="mon-events" ref={containerRef} onScroll={onScroll} data-testid="monitor-events">
        {events.length === 0 ? (
          <div className="mon-empty">
            {loading ? "Loading events…" : allEvents.length === 0 ? "No events yet." : view === "notable" ? "No notable events yet." : "No activity yet."}
          </div>
        ) : null}
        {events.map((frame) => {
          const line = formatEventLine(frame);
          return (
            <div className="mon-event" key={`${runId}:${line.seq}`}>
              <span className="mon-mono mon-dim">#{line.seq}</span>
              <span className="mon-event-name">{line.name}</span>
              <span className="mon-event-detail mon-dim">{line.detail}</span>
            </div>
          );
        })}
      </div>
    </section>
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
}: {
  runId: string;
  status: string | undefined;
  healthState: string | undefined;
  quota: ReturnType<typeof quotaInfoOf>;
}) {
  const tree = useGatewayRunTree(runId);
  const approvalsQuery = useGatewayApprovals();
  const treeNodes = tree.nodes ?? [];
  const approvalsCount = (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []).filter(
    (approval: unknown) => isRecord(approval) && approval.runId === runId,
  ).length;
  // One representative failure, so the strip can say WHY without a click.
  const failedTask = treeNodes.find(
    (node) => asString(node.status) === "failed" && !/^\d+$/.test(asString(node.id) ?? ""),
  );
  const failedNodeId = failedTask ? asString(failedTask.id) : undefined;
  const failedIteration = failedTask && typeof failedTask.iteration === "number" ? failedTask.iteration : 0;
  const sampleQuery = useGatewayNodeOutput({ runId, nodeId: failedNodeId, iteration: failedIteration });
  const sampleError = nodeErrorOf(sampleQuery.data);
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
    failureSample: failedNodeId && sampleError ? { nodeId: failedNodeId, message: sampleError.message } : null,
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
      <div className="mon-health-fix mon-dim">{diagnosis.fix}</div>
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
function formatSessionTranscriptLine(
  payload: unknown,
): { text: string; kind: "cmd" | "text" | "meta" } | null {
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
    let afterSeq = 0;
    let inFlight = false;
    const poll = async () => {
      // The first poll scans history and can outlive the interval; overlapping
      // polls would both start from the same cursor and append the tail twice.
      if (inFlight) return;
      inFlight = true;
      try {
        const search = new URLSearchParams({ nodeId, limit: "120" });
        if (afterSeq > 0) search.set("afterSeq", String(afterSeq));
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/events?${search}`);
        if (!response.ok) throw new Error(`events ${response.status}`);
        const body = (await response.json()) as { data?: unknown[] };
        const rows = Array.isArray(body.data) ? body.data : [];
        const fresh: Array<{ seq: number; text: string; kind: "cmd" | "text" | "meta" }> = [];
        for (const raw of rows) {
          if (!isRecord(raw)) continue;
          const name = String(raw.event ?? "");
          const seq = asNumber(raw.seq) ?? 0;
          if (seq > afterSeq) afterSeq = seq;
          if (name === "AgentSessionEvent") {
            const formatted = formatSessionTranscriptLine(raw.payload);
            if (formatted) fresh.push({ seq, ...formatted });
            continue;
          }
          if (!/AgentEvent|AgentTraceEvent|NodeOutput|ToolCall|task\.output|agent\.|NodeStarted|NodeFinished|NodeFailed|NodeRetrying/i.test(name)) continue;
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
        {failed
          ? "Could not load this node's events."
          : !loadedOnce
            ? <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> loading transcript…</span>
            : "No output from this node yet — its events land here as they arrive."}
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
 * The AI "what happened" recap at the top of the inspector. The gateway's
 * whatHappened RPC narrates with the host-configured cheap agent and falls
 * back to a deterministic fact summary, so this renders something for every
 * settled node; errors just hide the panel.
 */
function NodeWhatHappened({ runId, nodeId, iteration, status }: { runId: string; nodeId: string; iteration: number; status?: string }) {
  const enabled = nodeSummaryEligible(status);
  const summary = useGatewayRpc("whatHappened", { runId, nodeId, iteration }, { enabled });
  if (!enabled || summary.error) return null;
  return (
    <div className="mon-what" data-testid="monitor-what-happened">
      <h3 className="mon-kicker">What happened</h3>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// PTY hijack terminal. An embedded xterm.js terminal (the same stack the
// smithers cloud UI uses for its workspace terminals — ghostty stays a native
// app; the web falls back to xterm) attached to the gateway's /v1/pty/hijack
// websocket, which runs `smithers hijack <runId> --target <nodeId>` in a real
// PTY. Transport mirrors the cloud terminal client: binary frames are raw PTY
// bytes both ways; text frames are JSON control messages (`resize` up,
// `exit`/`error` down).
// ---------------------------------------------------------------------------

type HijackStatus = "connecting" | "connected" | "exited" | "closed" | "error";

const HIJACK_TERM_DARK = {
  background: "#07090d",
  foreground: "#f0f2f5",
  cursor: "#9ba1ad",
  selectionBackground: "rgba(123, 147, 217, 0.3)",
};

const HIJACK_TERM_LIGHT = {
  background: "#fbfcfd",
  foreground: "#17202a",
  cursor: "#315d98",
  selectionBackground: "rgba(49, 93, 152, 0.22)",
};

function isDarkTheme(): boolean {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Poll the gateway's per-node hijack candidates for a run (5s while live). */
function useHijackCandidates(runId: string, live: boolean): HijackCandidate[] {
  const [candidates, setCandidates] = useState<HijackCandidate[]>([]);
  useEffect(() => {
    setCandidates([]);
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/v1/api/runs/${encodeURIComponent(runId)}/hijack-candidates`);
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled) setCandidates(hijackCandidatesOf(body));
      } catch {
        // Transient fetch failures just keep the previous candidate view.
      }
    };
    void load();
    const timer = live ? setInterval(() => void load(), 5_000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, live]);
  return candidates;
}

function HijackTerminal({
  runId,
  nodeId,
  dark,
  onStatus,
}: {
  runId: string;
  nodeId: string;
  dark: boolean;
  onStatus: (status: HijackStatus) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;
    const ac = new AbortController();
    // Every resource is hoisted to effect scope and assigned as created, so
    // the cleanup always disposes whatever exists — including a teardown while
    // connect() is still awaiting the dynamic import (mirrors the cloud UI's
    // TerminalSession discipline).
    let term: XTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: IDisposable | null = null;
    let ws: WebSocket | null = null;
    const encoder = new TextEncoder();

    async function connect() {
      onStatus("connecting");
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (ac.signal.aborted || !host) return;
      // The mount div persists across effect re-runs — never stack a second
      // terminal into it.
      host.replaceChildren();
      term = new Terminal({
        theme: dark ? HIJACK_TERM_DARK : HIJACK_TERM_LIGHT,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        cursorBlink: true,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      fitAddon.fit();
      const boundTerm = term;
      const socket = new WebSocket(ptyHijackUrl(location.origin, runId, nodeId, { cols: boundTerm.cols, rows: boundTerm.rows }));
      ws = socket;
      socket.binaryType = "arraybuffer";
      const sendResize = () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: "resize", cols: boundTerm.cols, rows: boundTerm.rows }));
      };
      socket.onopen = () => {
        onStatus("connected");
        sendResize();
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // JSON control frames; unknown types are ignored for forward compat.
          try {
            const message = JSON.parse(event.data) as { type?: unknown; code?: unknown; message?: unknown };
            if (message.type === "exit") {
              onStatus("exited");
              boundTerm.writeln(`\r\n\x1b[2m[session ended${typeof message.code === "number" ? ` · exit ${message.code}` : ""}]\x1b[0m`);
            } else if (message.type === "error") {
              onStatus("error");
              boundTerm.writeln(`\r\n\x1b[1;31m${String(message.message ?? "PTY error")}\x1b[0m`);
            }
          } catch {
            // Not JSON: drop, PTY bytes only travel on binary frames.
          }
          return;
        }
        boundTerm.write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        onStatus("error");
        boundTerm.writeln("\r\n\x1b[1;31mTerminal socket error — the connection to the gateway failed.\x1b[0m");
      };
      socket.onclose = (event) => {
        if (event.code !== 1000) onStatus("closed");
      };
      dataDisposable = boundTerm.onData((data) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const bytes = encoder.encode(data);
        socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      });
      resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              fitAddon.fit();
              sendResize();
            })
          : null;
      resizeObserver?.observe(host);
      boundTerm.focus();
    }

    void connect().catch(() => {
      if (!ac.signal.aborted) onStatus("error");
    });

    return () => {
      ac.abort();
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      try {
        ws?.close(1000, "terminal closed");
      } catch {
        // Closing a CONNECTING socket can throw in some environments.
      }
      term?.dispose();
    };
  }, [runId, nodeId, dark]);
  return (
    <div
      className="mon-hijack-terminal"
      ref={mountRef}
      data-testid="monitor-hijack-terminal"
      style={{ background: dark ? HIJACK_TERM_DARK.background : HIJACK_TERM_LIGHT.background }}
    />
  );
}

const HIJACK_STATUS_TONES: Record<HijackStatus, Tone> = {
  connecting: "waiting",
  connected: "ok",
  exited: "idle",
  closed: "idle",
  error: "failed",
};

function HijackModal({
  runId,
  nodeId,
  label,
  engine,
  onClose,
}: {
  runId: string;
  nodeId: string;
  label: string;
  engine: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<HijackStatus>("connecting");
  const dark = isDarkTheme();
  return (
    <div className="mon-modal-backdrop" onClick={onClose} data-testid="monitor-hijack-modal">
      <div className="mon-modal mon-hijack-modal" onClick={(event) => event.stopPropagation()}>
        <header className="mon-modal-head">
          <span className="mon-kicker">
            {label}: <span className="mon-mono">{nodeId}</span> <span className="mon-dim">· {engine}</span>
          </span>
          <span className={`mon-conn tone-${HIJACK_STATUS_TONES[status]}`} data-status={status}>
            <ToneDot tone={HIJACK_STATUS_TONES[status]} pulse={status === "connected"} />
            {status}
          </span>
          <button type="button" className="mon-chip" onClick={onClose}>
            Close
          </button>
        </header>
        <HijackTerminal runId={runId} nodeId={nodeId} dark={dark} onStatus={setStatus} />
      </div>
    </div>
  );
}

function NodeInspector({ runId, node }: { runId: string; node: TreeNode }) {
  const nodeId = node.id ?? treeNodeKey(node);
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: node.iteration ?? 0 });
  const row = rowOf(output.data);
  const failure = nodeErrorOf(output.data);
  const isLive = !TERMINAL_NODE_TONES.has(String(node.status ?? ""));
  const toolCalls = asArray(node.toolCalls).filter(isRecord);
  const agentName = isRecord(node.agent) ? asString(node.agent.name) : asString(node.agent);
  // Hijack affordance: only nodes whose attempts recorded a resumable agent
  // session get a button (live run + live node = hand-off; settled run =
  // reopen the session post-mortem). Compute nodes never show one.
  const runQuery = useGatewayRun(runId);
  const runStatus = isRecord(runQuery.data) ? asString(runQuery.data.status) : undefined;
  const candidates = useHijackCandidates(runId, isLive);
  const candidate = hijackCandidateForNode(candidates, nodeId);
  const hijackAction = hijackActionFor(runStatus, isLive, candidate !== null);
  const [showHijack, setShowHijack] = useState(false);
  // Containers (parallel, sequence, loop, worktree, merge-queue, …) group
  // other nodes and never own a transcript or structured output — showing
  // those panels there is pure noise. Leaf kinds keep the full inspector.
  const kind = String(node.kind ?? "").toLowerCase();
  const isContainer = !["task", "agent", "compute", "static"].includes(kind) && (node.children?.length ?? 0) > 0;
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
        {hijackAction && candidate ? (
          <button
            type="button"
            className="mon-btn"
            data-testid="monitor-hijack-button"
            data-hijack-kind={hijackAction.kind}
            title={
              hijackAction.kind === "hijack"
                ? `Take over this node's live ${candidate.engine} session in an embedded terminal`
                : `Reopen this node's recorded ${candidate.engine} session in an embedded terminal`
            }
            onClick={() => setShowHijack(true)}
          >
            {hijackAction.label}
          </button>
        ) : null}
        <StatusTag status={node.status} />
      </header>
      {showHijack && hijackAction && candidate ? (
        <HijackModal
          runId={runId}
          nodeId={nodeId}
          label={hijackAction.label}
          engine={candidate.engine}
          onClose={() => setShowHijack(false)}
        />
      ) : null}
      <div className="mon-inspector-title">{node.cardLabel ?? node.name ?? nodeId}</div>
      <NodeWhatHappened runId={runId} nodeId={nodeId} iteration={node.iteration ?? 0} status={node.status} />
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
        {typeof node.iteration === "number" ? (
          <>
            <dt>iteration</dt>
            <dd className="mon-mono">{node.iteration}</dd>
          </>
        ) : null}
      </dl>
      {toolCalls.length > 0 ? (
        <>
          <h3 className="mon-kicker">Tool calls</h3>
          <div className="mon-toolcalls">
            {toolCalls.map((call, index) => (
              <div className="mon-toolcall" key={index}>
                <span className="mon-mono">{asString(call.name) ?? asString(call.tool) ?? "tool"}</span>
                <StatusTag status={asString(call.status) ?? asString(call.state)} />
              </div>
            ))}
          </div>
        </>
      ) : null}
      {failure && !isContainer ? (
        <>
          <h3 className="mon-kicker">Failure</h3>
          <div className="mon-banner tone-failed">
            {[failure.name, failure.code].filter(Boolean).join(" · ")}
            {typeof failure.attempt === "number" ? ` · attempt ${failure.attempt}` : ""}
            {failure.agent ? ` · ${failure.agent}` : ""}
          </div>
          <pre className="mon-output mon-failure">{failure.message}</pre>
        </>
      ) : null}
      {isContainer ? (
        <>
          <h3 className="mon-kicker">Children</h3>
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
        </>
      ) : (
        <>
          <div className="mon-kicker-row">
            <h3 className="mon-kicker">{isLive ? "Live output" : "Transcript"}</h3>
            {hijackAction && candidate ? (
              <button
                type="button"
                className="mon-btn mon-hijack-inline"
                data-testid="monitor-hijack-inline"
                title={
                  hijackAction.kind === "hijack"
                    ? `Take over this node's live ${candidate.engine} session in an embedded terminal`
                    : `Reopen this node's recorded ${candidate.engine} session in an embedded terminal`
                }
                onClick={() => setShowHijack(true)}
              >
                ⌁ {hijackAction.kind === "hijack" ? "Hijack terminal" : "Reopen terminal"}
              </button>
            ) : null}
          </div>
          <NodeLiveOutput runId={runId} nodeId={nodeId} live={isLive} />
          <h3 className="mon-kicker">Output</h3>
          {row ? (
            <OutputFields row={row} />
          ) : output.loading ? (
            <div className="mon-empty mon-dim">
              <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> loading output…</span>
            </div>
          ) : (
            <div className="mon-empty mon-dim">
              {failure
                ? "The node failed before producing output."
                : isLive
                  ? <span className="mon-live-pending"><span className="mon-dot mon-dot-pulse" aria-hidden /> running — structured output lands here when the node finishes</span>
                  : "No output recorded for this node."}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Run detail (header + lifecycle actions + tree + events).
// ---------------------------------------------------------------------------

function RunDetail({
  runId,
  onResult,
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
}: {
  runId: string;
  onResult: (kind: "ok" | "err", text: string) => void;
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
  const [busyAction, setBusyAction] = useState<"cancel" | "resume" | null>(null);
  const [showCustomUi, setShowCustomUi] = useState(false);
  const [creatingUi, setCreatingUi] = useState(false);
  const workflowsRefetch = workflowsQuery.refetch;
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

  if (!run && runQuery.loading) return <div className="mon-empty">Loading run…</div>;
  if (!run) {
    return (
      <div className="mon-empty" data-testid="monitor-run-missing">
        <div>Run not found.</div>
        <div className="mon-dim mon-mono">{runId}</div>
      </div>
    );
  }

  const status = asString(run.status);
  const workflowKey = asString(run.workflowKey) ?? "unknown";
  const startedAtMs = asNumber(pick(run, "startedAtMs", "started_at_ms")) ?? asNumber(pick(run, "createdAtMs", "created_at_ms"));
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
  const progress = runProgress(run.summary);

  const act = async (kind: "cancel" | "resume") => {
    if (kind === "cancel" && !window.confirm(`Cancel run ${shortRunId(runId)} (${workflowKey})?`)) return;
    setBusyAction(kind);
    try {
      if (kind === "cancel") {
        await actions.cancelRun({ runId });
        onResult("ok", `Cancel requested for ${shortRunId(runId)}. The row updates when the engine confirms.`);
      } else {
        await actions.resumeRun({ runId });
        onResult("ok", `Resume requested for ${shortRunId(runId)}.`);
      }
    } catch (error) {
      onResult("err", `${kind === "cancel" ? "Cancel" : "Resume"} failed: ${error instanceof Error ? error.message : String(error)}`);
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
          <span className="mon-dim">
            <Elapsed startMs={startedAtMs} endMs={finishedAtMs} />
          </span>
        </div>
        <CopyableRunId runId={runId} />
        {progress ? (
          <div className="mon-progress" title={`${progress.done} done · ${progress.failed} failed · ${progress.total} nodes`}>
            <div className="mon-progress-track">
              <div className="mon-progress-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
            <span className="mon-dim mon-mono">
              {progress.done + progress.failed}/{progress.total}
              {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
            </span>
          </div>
        ) : null}
        <div className="mon-detail-actions">
          {customUiUrl ? (
            <button type="button" className="mon-btn" onClick={() => setShowCustomUi(true)} title={`Open this workflow's custom UI (${customUiPath})`}>
              Open UI
            </button>
          ) : workflowRow && workflowKey !== "create-ui" ? (
            <button
              type="button"
              className="mon-btn"
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
                    onResult("ok", `Creating a UI for ${workflowKey} — the Open UI button appears here when it's ready (a few minutes).`);
                  })
                  .catch((error) => {
                    setCreatingUi(false);
                    onResult("err", `Create UI failed to launch: ${error instanceof Error ? error.message : String(error)}`);
                  });
              }}
            >
              {creatingUi ? "Creating UI…" : "Create UI"}
            </button>
          ) : null}
          {isResumable(status) ? (
            <button type="button" className="mon-btn" disabled={busyAction !== null} onClick={() => void act("resume")}>
              Resume
            </button>
          ) : null}
          {isCancellable(status) ? (
            <button
              type="button"
              className="mon-btn mon-btn-danger"
              disabled={busyAction !== null}
              onClick={() => void act("cancel")}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </header>

      <HealthStrip runId={runId} status={status} healthState={healthState} quota={quota} />

      {showCustomUi && customUiUrl ? (
        <div className="mon-modal-backdrop" onClick={() => setShowCustomUi(false)} data-testid="monitor-ui-modal">
          <div className="mon-modal" onClick={(event) => event.stopPropagation()}>
            <header className="mon-modal-head">
              <span className="mon-kicker">{workflowKey} UI</span>
              <a className="mon-chip" href={customUiUrl} target="_blank" rel="noreferrer">
                Open in new tab
              </a>
              <button type="button" className="mon-chip" onClick={() => setShowCustomUi(false)}>
                Close
              </button>
            </header>
            <iframe className="mon-modal-frame" src={customUiUrl} title={`${workflowKey} custom UI`} />
          </div>
        </div>
      ) : null}

      <ExecutionPanel
        runId={runId}
        selectedNode={selectedNode}
        onSelectNode={onSelectNode}
        autoSelectNodeId={autoSelectNodeId}
        onAutoSelected={onAutoSelected}
      />

      <EventLog runId={runId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell.
// ---------------------------------------------------------------------------

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<TreeNode | undefined>(undefined);
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { status: connStatus } = useGatewayConnectionStatus();
  // No offset/cursor in the gateway's ListRunsRequest filter, so fetch a wide
  // window and let the landing table paginate client-side (RUNS_PAGE_SIZE).
  const runsQuery = useGatewayRuns({ filter: { limit: 1000 } });
  const allRuns = (runsQuery.data ?? []) as RunRow[];
  const [runsPage, setRunsPage] = useState(1);

  // Resolve ?runId=&nodeId= once, when runs first arrive. An unknown id still
  // selects (RunDetail renders an honest "Run not found" state).
  const urlResolved = useRef(false);
  const initialNodeId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (urlResolved.current || allRuns.length === 0) return;
    urlResolved.current = true;
    const fromUrl = readUrlSelection();
    if (fromUrl.runId) {
      setSelectedRunId(fromUrl.runId);
      initialNodeId.current = fromUrl.nodeId;
    }
  }, [allRuns.length]);

  const selectRun = (runId: string | undefined) => {
    setSelectedRunId(runId);
    setSelectedNode(undefined);
    writeUrlSelection(runId, undefined);
  };
  const selectNode = (node: TreeNode | undefined) => {
    setSelectedNode(node);
    writeUrlSelection(selectedRunId, node ? (node.id ?? treeNodeKey(node)) : undefined);
  };

  const showResult = (kind: "ok" | "err", text: string) => {
    setBanner({ kind, text });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    if (kind === "ok") bannerTimer.current = setTimeout(() => setBanner(null), 4000);
  };

  const visibleRuns = useMemo(
    () => filterRuns(allRuns, { text: filterText, status: statusFilter, workflow: workflowFilter }),
    [allRuns, filterText, statusFilter, workflowFilter],
  );
  // A changed filter means a new result set: land back on its first page.
  useEffect(() => {
    setRunsPage(1);
  }, [filterText, statusFilter, workflowFilter]);
  const workflows = useMemo(() => workflowOptions(allRuns), [allRuns]);
  const statuses = useMemo(() => statusOptions(allRuns), [allRuns]);

  return (
    <main className="mon-shell" data-testid="monitor-root">
      <WorkflowUiStyles mode="theme" extra={`${monitorCss}\n${xtermCss}`} />
      <header className="mon-topbar">
        <div className="mon-brand">
          <span className="mon-brand-mark" aria-hidden />
          <h1>Smithers Monitor</h1>
          <ConnectionBadge />
        </div>
        <div className="mon-toolbar">
          <input
            className="mon-input"
            data-testid="monitor-filter"
            value={filterText}
            onChange={(event) => setFilterText(event.currentTarget.value)}
            placeholder="Search runs…"
            type="search"
          />
          <select className="mon-select" value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
            <option value="all">all statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select className="mon-select" value={workflowFilter} onChange={(event) => setWorkflowFilter(event.currentTarget.value)}>
            <option value="all">all workflows</option>
            {workflows.map((workflow) => (
              <option key={workflow} value={workflow}>
                {workflow}
              </option>
            ))}
          </select>
          <span className="mon-dim mon-count-note">
            {visibleRuns.length}/{allRuns.length} runs
          </span>
          <button type="button" className="mon-btn" onClick={() => void runsQuery.refetch()}>
            Refresh
          </button>
        </div>
      </header>

      {banner ? (
        <div className={`mon-banner mon-banner-app tone-${banner.kind === "ok" ? "ok" : "failed"}`} role="status">
          {banner.text}
          <button type="button" className="mon-chip" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="mon-body">
        <div className="mon-rail">
          <ApprovalsInbox onSelectRun={selectRun} onResult={showResult} />
          <RunsRail
            runs={visibleRuns}
            loading={runsQuery.loading ?? false}
            offline={connStatus === "offline" || connStatus === "unauthorized"}
            selectedRunId={selectedRunId}
            onSelect={selectRun}
          />
        </div>

        <div className="mon-main">
          {selectedRunId ? (
            <RunDetail
              runId={selectedRunId}
              onResult={showResult}
              selectedNode={selectedNode}
              onSelectNode={selectNode}
              autoSelectNodeId={initialNodeId.current}
              onAutoSelected={() => {
                initialNodeId.current = undefined;
              }}
            />
          ) : (
            <RunsTable
              runs={visibleRuns}
              loading={runsQuery.loading ?? false}
              page={runsPage}
              onPageChange={setRunsPage}
              onSelect={selectRun}
            />
          )}
        </div>

        {selectedRunId && selectedNode ? <NodeInspector runId={selectedRunId} node={selectedNode} /> : null}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Styles. Token-first on top of the shared workflow-UI theme (light by
// default, OS dark mode, `data-theme` override) — every color is a theme
// variable or a color-mix tint of one; tones carry state, never decoration.
//
// Geometry comes from the token scales below (also exported for every
// workflow UI by WorkflowUiStyles): spacing --sp-*, type --fs-*/--lh-*,
// radius --r-*, and one control height --ctl-h shared by every button, chip,
// input, and select. No bare pixel values in spacing/radius/font-size rules.
// ---------------------------------------------------------------------------

const monitorCss = `
:root {
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px;
  --fs-1: 11px; --fs-2: 12px; --fs-3: 13px; --fs-4: 15px;
  --lh-tight: 1.35; --lh-body: 1.5;
  --r-1: 6px; --r-2: 9px; --r-3: 12px; --r-full: 999px;
  --ctl-h: 28px;
  --panel-pad: var(--sp-4);
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: var(--fs-3); line-height: var(--lh-body); }
button, input, select { font: inherit; color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-2); background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-1); padding: 0 var(--sp-1); }

.tone-running { --tone: var(--brand); }
.tone-ok { --tone: var(--ok); }
.tone-waiting { --tone: var(--warn); }
.tone-failed { --tone: var(--err); }
.tone-idle { --tone: var(--muted); }

.mon-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.mon-topbar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.mon-brand { display: flex; align-items: center; gap: var(--sp-2); }
.mon-brand h1 { margin: 0; font-size: var(--fs-3); font-weight: 700; letter-spacing: -0.01em; }
.mon-brand-mark { width: 10px; height: 10px; border-radius: var(--r-full); background: var(--brand); }
.mon-conn { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); font-weight: 600; color: var(--tone); }
.mon-toolbar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-input, .mon-select { height: var(--ctl-h); padding: 0 var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--surface); color: var(--text); }
.mon-input { min-width: 200px; }
.mon-input:focus-visible, .mon-select:focus-visible, .mon-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.mon-count-note { font-size: var(--fs-1); font-variant-numeric: tabular-nums; }

/* Buttons and chips share one control geometry: height, padding, radius. */
.mon-btn { display: inline-flex; align-items: center; gap: var(--sp-1); height: var(--ctl-h); padding: 0 var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-1); background: var(--surface); cursor: pointer; font-weight: 600; font-size: var(--fs-2); white-space: nowrap; }
.mon-btn:hover { background: var(--hover); }
.mon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mon-btn-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.mon-btn-danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }
.mon-chip { display: inline-flex; align-items: center; gap: var(--sp-1); height: var(--ctl-h); padding: 0 var(--sp-3); border-radius: var(--r-1); font-size: var(--fs-1); font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; white-space: nowrap; text-decoration: none; }
.mon-chip:hover { background: var(--hover); }
.mon-chip.is-on { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 40%, var(--border)); }

.mon-kicker { margin: 0; font-size: var(--fs-1); line-height: var(--lh-tight); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.mon-kicker-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.mon-child-rollup { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.mon-child-stat { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-1); }
.mon-container-note { font-size: var(--fs-1); }
.mon-hijack-inline { flex: none; }
.mon-tree-xml { font-family: var(--mono, ui-monospace, monospace); }
.mon-xml-row { display: flex; align-items: baseline; gap: 2px; line-height: 1.7; }
.mon-xml-row.is-active { background: color-mix(in srgb, var(--brand) 12%, transparent); border-radius: var(--r-1); }
.mon-xml-open { display: inline; border: 0; background: none; padding: 0; margin: 0; cursor: pointer; font: inherit; text-align: left; color: inherit; }
.mon-xml-open:hover .mon-xml-tag { text-decoration: underline; }
.mon-xml-punct { color: var(--dim); }
.mon-xml-tag { color: var(--brand); }
.mon-xml-attr-name { color: var(--muted); }
.mon-xml-str { color: var(--ok); }
.mon-xml-status { color: var(--tone, var(--ok)); }
.mon-xml-ellipsis { color: var(--muted); padding: 0 2px; }
.mon-count { font-variant-numeric: tabular-nums; color: var(--text); }
.mon-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-1); }
.mon-dim { color: var(--muted); }

.mon-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone, var(--muted)); flex: none; }
.mon-dot-pulse { animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-pill { display: inline-flex; align-items: center; gap: var(--sp-1); height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); font-size: var(--fs-1); font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); white-space: nowrap; }

/* Banners (app-level, health strip, inline errors) share one geometry. */
.mon-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin: 0 0 var(--sp-4); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-2); font-weight: 600; font-size: var(--fs-2); color: var(--tone); background: color-mix(in srgb, var(--tone) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--border)); animation: mon-in 140ms ease-out; }
.mon-banner-app { margin: var(--sp-2) var(--sp-4) 0; }

.mon-body { display: grid; grid-template-columns: 320px minmax(420px, 1fr) minmax(0, 380px); flex: 1; overflow: hidden; }
.mon-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-4); }
.mon-main { overflow-y: auto; padding: var(--sp-4); }
.mon-inspector { border-left: 1px solid var(--border); overflow-y: auto; padding: var(--panel-pad); animation: mon-in 140ms ease-out; }
@media (max-width: 1160px) {
  .mon-body { grid-template-columns: 300px 1fr; }
  .mon-inspector { position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 90vw); background: var(--bg); box-shadow: -12px 0 36px rgb(0 0 0 / 0.14); z-index: 10; }
}

.mon-inbox { border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border)); border-radius: var(--r-3); padding: var(--panel-pad); background: color-mix(in srgb, var(--warn) 5%, var(--surface)); animation: mon-in 140ms ease-out; }
.mon-inbox .mon-kicker { margin-bottom: var(--sp-1); }
.mon-approval { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) 0; border-top: 1px solid var(--border); }
.mon-approval:first-of-type { border-top: 0; }
.mon-approval:last-of-type { padding-bottom: 0; }
.mon-approval-main { text-align: left; background: none; border: 0; padding: 0; cursor: pointer; }
.mon-approval-title { font-weight: 600; }
.mon-approval-meta { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.mon-approval-summary { color: var(--muted); font-size: var(--fs-2); }
.mon-approval-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-1); }
.mon-wait { font-size: var(--fs-1); font-weight: 600; color: var(--tone); }

.mon-run-group { display: flex; flex-direction: column; }
.mon-run-group .mon-kicker { padding: 0 var(--sp-1) var(--sp-1); }
.mon-run-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; text-align: left; padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r-1); background: none; cursor: pointer; }
.mon-run-row:hover { background: var(--hover); }
.mon-run-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); box-shadow: inset 2px 0 0 var(--brand); }
.mon-run-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-run-when { margin-left: auto; font-size: var(--fs-1); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Landing runs table: fills the main column; the table body scrolls inside the
   panel (sticky header), never the page. */
.mon-runs-table-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; margin: 0; }
.mon-runs-table-panel .mon-panel-head { margin-bottom: var(--sp-2); }
.mon-runs-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-2); }
.mon-runs-table { width: 100%; border-collapse: collapse; font-size: var(--fs-2); }
.mon-runs-table th { position: sticky; top: 0; z-index: 1; background: var(--surface); text-align: left; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-1); line-height: var(--lh-tight); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
.mon-runs-table td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
.mon-runs-table tbody tr:last-child td { border-bottom: 0; }
.mon-runs-table-row { cursor: pointer; }
.mon-runs-table-row:hover { background: var(--hover); }
.mon-table-workflow { font-weight: 600; max-width: 0; width: 40%; overflow: hidden; text-overflow: ellipsis; }
.mon-table-failed { color: var(--tone); font-weight: 600; }
.mon-runs-pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding-top: var(--sp-3); flex-wrap: wrap; }
.mon-runs-pagination-controls { display: inline-flex; align-items: center; gap: var(--sp-2); }

/* All panels share one padding, radius, and stacking rhythm. */
.mon-panel { border: 1px solid var(--border); border-radius: var(--r-3); background: var(--surface); padding: var(--panel-pad); margin: 0 0 var(--sp-4); animation: mon-in 140ms ease-out; }
.mon-panel-head { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--ctl-h); margin-bottom: var(--sp-3); }
.mon-panel-head .mon-kicker { margin-right: auto; }

.mon-detail-head { display: flex; flex-direction: column; gap: var(--sp-2); }
.mon-detail-title { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.mon-detail-workflow { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); letter-spacing: -0.01em; }
.mon-detail-actions { display: flex; gap: var(--sp-2); }
.mon-runid { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-1); color: var(--muted); }
.mon-runid:hover { color: var(--text); }
.mon-progress { display: flex; align-items: center; gap: var(--sp-2); }
.mon-progress-track { flex: 1; max-width: 320px; height: 5px; border-radius: var(--r-full); background: color-mix(in srgb, var(--brand) 12%, transparent); overflow: hidden; }
.mon-progress-fill { height: 100%; border-radius: var(--r-full); background: var(--brand); transition: width 300ms ease; }

.mon-tree { overflow-x: auto; }
.mon-tree-row { display: flex; align-items: center; border-radius: var(--r-1); }
.mon-tree-row:hover { background: var(--hover); }
.mon-tree-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); }
.mon-tree-chevron { width: 20px; flex: none; background: none; border: 0; cursor: pointer; color: var(--muted); text-align: center; }
.mon-tree-main { display: flex; align-items: center; gap: var(--sp-2); flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: var(--sp-1) var(--sp-2) var(--sp-1) 0; cursor: pointer; }
.mon-tree-glyph { flex: none; width: 14px; text-align: center; }
.mon-tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-tree-main .mon-pill { margin-left: auto; }
.mon-tree-main .mon-chip { height: 20px; padding: 0 var(--sp-2); border-radius: var(--r-full); cursor: inherit; }
.mon-tree.is-static .mon-tree-main { cursor: default; }
.mon-tree.is-static { opacity: 0.92; }

.mon-scrub { display: flex; align-items: center; gap: var(--sp-2); padding: 0 0 var(--sp-3); }
.mon-scrub-range { flex: 1; min-width: 120px; accent-color: var(--brand); }
.mon-scrub-range:disabled { opacity: 0.45; }
.mon-scrub-note { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mon-scrub-loading { font-size: var(--fs-1); white-space: nowrap; animation: mon-pulse 1.2s ease-in-out infinite; }

.mon-events-panel { display: flex; flex-direction: column; }
.mon-events { max-height: 300px; overflow-y: auto; font-size: var(--fs-1); }
.mon-event { display: flex; gap: var(--sp-2); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); align-items: baseline; }
.mon-event:last-child { border-bottom: 0; }
.mon-event-name { font-weight: 600; white-space: nowrap; }
.mon-event-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mon-inspector-title { font-weight: 700; font-size: var(--fs-4); line-height: var(--lh-tight); margin: var(--sp-1) 0 var(--sp-3); }
.mon-what { margin: 0 0 var(--sp-3); }
.mon-what-summary { white-space: pre-wrap; font-size: var(--fs-3); line-height: var(--lh-body); background: color-mix(in srgb, var(--brand) 6%, transparent); border-radius: var(--r-1); padding: var(--sp-2) var(--sp-3); }
.mon-what-source { font-size: var(--fs-1); margin-top: var(--sp-1); }
.mon-inspector h3.mon-kicker { margin: var(--sp-4) 0 var(--sp-2); }
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
.mon-failure { border-color: color-mix(in srgb, var(--failed, #f87171) 45%, var(--border)); }
.mon-live-output { max-height: 32vh; }
.mon-live-line { border-bottom: 1px dashed color-mix(in srgb, var(--border) 55%, transparent); overflow-wrap: anywhere; }
.mon-live-cmd { font-family: ui-monospace, monospace; color: color-mix(in srgb, var(--text) 82%, transparent); }
.mon-live-text { }
.mon-live-meta { color: var(--muted); font-style: italic; }
.mon-live-pending { display: inline-flex; align-items: center; gap: var(--sp-2); }
.mon-live-line:last-child { border-bottom: 0; }
.mon-quota { flex-direction: column; align-items: flex-start; }
.mon-health { flex-direction: column; align-items: flex-start; gap: var(--sp-1); }
.mon-health-headline { display: flex; align-items: center; gap: var(--sp-2); }
.mon-health-dot { width: 8px; height: 8px; border-radius: var(--r-full); background: var(--tone); box-shadow: 0 0 6px color-mix(in srgb, var(--tone) 60%, transparent); }
.mon-health-detail { font-weight: 400; overflow-wrap: anywhere; }
.mon-health-fix { font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-weight: 400; font-size: var(--fs-1); }
.mon-quota-list li { overflow-wrap: anywhere; }
.mon-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: var(--sp-6); }
.mon-modal { width: min(1280px, 96vw); height: min(860px, 92vh); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); overflow: hidden; box-shadow: 0 18px 60px rgba(0,0,0,0.45); }
.mon-modal-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
.mon-modal-head .mon-kicker { flex: 1; }
.mon-modal-frame { flex: 1; border: 0; width: 100%; background: white; }

/* PTY hijack terminal: the modal hosts one xterm.js instance; the mount fills
   the modal body and the terminal's own theme paints the surface. */
.mon-hijack-modal { width: min(1080px, 96vw); height: min(720px, 88vh); }
.mon-hijack-terminal { flex: 1; min-height: 0; padding: var(--sp-2) var(--sp-3); }
.mon-hijack-terminal .xterm { height: 100%; }

.mon-empty { color: var(--muted); text-align: center; padding: var(--sp-6) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-1); }
.mon-empty-hero { padding-top: 18vh; }

@keyframes mon-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .mon-dot-pulse, .mon-panel, .mon-banner, .mon-inspector, .mon-inbox { animation: none; }
  * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
}
`;

createGatewayReactRoot(<App />);
