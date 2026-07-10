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
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
  useGatewayRunTree,
} from "smithers-orchestrator/gateway-react";
import { WorkflowUiStyles } from "smithers-orchestrator/gateway-ui";
import {
  asArray,
  asNumber,
  asString,
  autoExpandKeys,
  filterRuns,
  formatElapsed,
  formatEventLine,
  formatOutputValue,
  groupRuns,
  hasFailedDescendant,
  isCancellable,
  isNotableEvent,
  isRecord,
  isResumable,
  labelForStatus,
  nodeErrorOf,
  pick,
  rowOf,
  runProgress,
  shortRunId,
  statusOptions,
  timeAgo,
  toneForStatus,
  treeNodeKey,
  waitTone,
  workflowOptions,
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
  selectedRunId,
  onSelect,
}: {
  runs: RunRow[];
  loading: boolean;
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}) {
  const groups = groupRuns(runs);
  return (
    <nav className="mon-rail-runs" data-testid="monitor-runs">
      {loading && runs.length === 0 ? <div className="mon-empty">Loading runs…</div> : null}
      {!loading && runs.length === 0 ? (
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

function TreeRow({
  node,
  depth,
  expandedOverrides,
  defaults,
  selectedNodeKey,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  expandedOverrides: ReadonlyMap<string, boolean>;
  defaults: ReadonlySet<string>;
  selectedNodeKey: string | undefined;
  onToggle: (key: string) => void;
  onSelect: (node: TreeNode) => void;
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
        <button type="button" className="mon-tree-main" onClick={() => onSelect(node)}>
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
}: {
  runId: string;
  selectedNodeKey: string | undefined;
  onSelectNode: (node: TreeNode) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
}) {
  const { root, nodes, isLoading, error } = useGatewayRunTree(runId);
  // ?nodeId= deep link: select the node once it exists in the tree.
  useEffect(() => {
    if (!autoSelectNodeId || nodes.length === 0) return;
    const match = (nodes as TreeNode[]).find(
      (candidate) => candidate.id === autoSelectNodeId || treeNodeKey(candidate) === autoSelectNodeId,
    );
    if (match) {
      onSelectNode(match);
      onAutoSelected?.();
    }
  }, [autoSelectNodeId, nodes.length]);
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  // Reset user toggles when switching runs.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    if (overrides.size > 0) setOverrides(new Map());
  }
  const defaults = useMemo(() => autoExpandKeys(root as TreeNodeLike | null), [root]);
  if (error) {
    return (
      <div className="mon-empty">
        Failed to load the execution tree. <span className="mon-dim">{error.message}</span>
      </div>
    );
  }
  if (isLoading) return <div className="mon-empty">Loading execution tree…</div>;
  if (!root) return <div className="mon-empty">No nodes recorded yet.</div>;
  return (
    <div role="tree" className="mon-tree" data-testid="monitor-tree">
      <TreeRow
        node={root as TreeNode}
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
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live event log with follow mode: auto-scrolls while you stay near the
// bottom; scrolling up pauses following; the Follow chip re-engages it.
// ---------------------------------------------------------------------------

const FOLLOW_THRESHOLD_PX = 80;

function EventLog({ runId }: { runId: string }) {
  const { events: allEvents, streaming, error } = useGatewayRunEvents(runId, { maxEvents: 500 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  // Default to the transitions a human acts on; agent chatter and heartbeats
  // stay one click away instead of drowning the log.
  const [showAll, setShowAll] = useState(false);
  const events = useMemo(
    () => (showAll ? allEvents : allEvents.filter((frame) => isNotableEvent(asString(frame.event) ?? ""))),
    [allEvents, showAll],
  );

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
          Events <span className="mon-count">{events.length}{showAll ? "" : `/${allEvents.length}`}</span>
        </h2>
        <button
          type="button"
          className={`mon-chip${showAll ? "" : " is-on"}`}
          onClick={() => setShowAll(false)}
          title="Node/run lifecycle, approvals, human requests"
        >
          Notable
        </button>
        <button
          type="button"
          className={`mon-chip${showAll ? " is-on" : ""}`}
          onClick={() => setShowAll(true)}
          title="Every event, including agent chatter and heartbeats"
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
          <div className="mon-empty">{allEvents.length === 0 ? "No events yet." : "No notable events yet."}</div>
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
// Node inspector.
// ---------------------------------------------------------------------------

function NodeInspector({ runId, node }: { runId: string; node: TreeNode }) {
  const nodeId = node.id ?? treeNodeKey(node);
  const output = useGatewayNodeOutput({ runId, nodeId, iteration: node.iteration ?? 0 });
  const row = rowOf(output.data);
  const failure = nodeErrorOf(output.data);
  const toolCalls = asArray(node.toolCalls).filter(isRecord);
  const agentName = isRecord(node.agent) ? asString(node.agent.name) : asString(node.agent);
  return (
    <aside className="mon-inspector" data-testid="monitor-inspector">
      <header className="mon-panel-head">
        <h2 className="mon-kicker">Node</h2>
        <StatusTag status={node.status} />
      </header>
      <div className="mon-inspector-title">{node.cardLabel ?? node.name ?? nodeId}</div>
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
      {failure ? (
        <>
          <h3 className="mon-kicker">Failure</h3>
          <div className="mon-banner tone-failed">
            {[failure.name, failure.code].filter(Boolean).join(" · ")}
            {typeof failure.attempt === "number" ? ` · attempt ${failure.attempt}` : ""}
          </div>
          <pre className="mon-output mon-failure">{failure.message}</pre>
        </>
      ) : null}
      <h3 className="mon-kicker">Output</h3>
      {row ? (
        <pre className="mon-output">{formatOutputValue(row)}</pre>
      ) : (
        <div className="mon-empty mon-dim">
          {failure ? "The node failed before producing output." : "No output recorded for this node."}
        </div>
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
  const [busyAction, setBusyAction] = useState<"cancel" | "resume" | null>(null);
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

      <section className="mon-panel mon-tree-panel">
        <header className="mon-panel-head">
          <h2 className="mon-kicker">Execution</h2>
          {selectedNode ? (
            <button type="button" className="mon-chip" onClick={() => onSelectNode(undefined)}>
              Clear selection
            </button>
          ) : null}
        </header>
        <ExecutionTree
          runId={runId}
          selectedNodeKey={selectedNode ? treeNodeKey(selectedNode) : undefined}
          onSelectNode={onSelectNode}
          autoSelectNodeId={autoSelectNodeId}
          onAutoSelected={onAutoSelected}
        />
      </section>

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

  const runsQuery = useGatewayRuns({ filter: { limit: 200 } });
  const allRuns = (runsQuery.data ?? []) as RunRow[];

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
  const workflows = useMemo(() => workflowOptions(allRuns), [allRuns]);
  const statuses = useMemo(() => statusOptions(allRuns), [allRuns]);

  return (
    <main className="mon-shell" data-testid="monitor-root">
      <WorkflowUiStyles mode="theme" extra={monitorCss} />
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
        <div className={`mon-banner tone-${banner.kind === "ok" ? "ok" : "failed"}`} role="status">
          {banner.text}
          <button type="button" className="mon-chip" onClick={() => setBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="mon-body">
        <div className="mon-rail">
          <ApprovalsInbox onSelectRun={selectRun} onResult={showResult} />
          <RunsRail runs={visibleRuns} loading={runsQuery.loading ?? false} selectedRunId={selectedRunId} onSelect={selectRun} />
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
            <div className="mon-empty mon-empty-hero" data-testid="monitor-empty-detail">
              <div>Select a run to inspect it.</div>
              <div className="mon-dim">
                Live status, execution tree, node outputs, events, and approvals — for every run this gateway owns.
              </div>
            </div>
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
// ---------------------------------------------------------------------------

const monitorCss = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.5; }
button, input, select { font: inherit; color: inherit; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

.tone-running { --tone: var(--brand); }
.tone-ok { --tone: var(--ok); }
.tone-waiting { --tone: var(--warn); }
.tone-failed { --tone: var(--err); }
.tone-idle { --tone: var(--muted); }

.mon-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.mon-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.mon-brand { display: flex; align-items: center; gap: 10px; }
.mon-brand h1 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.01em; }
.mon-brand-mark { width: 10px; height: 10px; border-radius: 3px; background: var(--brand); }
.mon-conn { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--tone); }
.mon-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mon-input, .mon-select { height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); }
.mon-input { min-width: 200px; }
.mon-input:focus-visible, .mon-select:focus-visible, .mon-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.mon-count-note { font-size: 11px; font-variant-numeric: tabular-nums; }

.mon-btn { height: 28px; padding: 0 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); cursor: pointer; font-weight: 600; font-size: 12px; }
.mon-btn:hover { background: var(--hover); }
.mon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mon-btn-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
.mon-btn-danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--border)); }

.mon-kicker { margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.mon-count { font-variant-numeric: tabular-nums; color: var(--text); }
.mon-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.mon-dim { color: var(--muted); }

.mon-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--tone, var(--muted)); flex: none; }
.mon-dot-pulse { animation: mon-pulse 1.2s ease-in-out infinite; }
.mon-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--tone); background: color-mix(in srgb, var(--tone) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent); white-space: nowrap; }
.mon-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
.mon-chip:hover { background: var(--hover); }
.mon-follow.is-on { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 40%, var(--border)); }

.mon-banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 8px 16px 0; padding: 8px 12px; border-radius: 9px; font-weight: 600; font-size: 12px; color: var(--tone); background: color-mix(in srgb, var(--tone) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--tone) 30%, var(--border)); animation: mon-in 140ms ease-out; }

.mon-body { display: grid; grid-template-columns: 320px minmax(420px, 1fr) minmax(0, 380px); flex: 1; overflow: hidden; }
.mon-rail { border-right: 1px solid var(--border); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.mon-main { overflow-y: auto; padding: 14px 16px; }
.mon-inspector { border-left: 1px solid var(--border); overflow-y: auto; padding: 14px; animation: mon-in 140ms ease-out; }
@media (max-width: 1160px) {
  .mon-body { grid-template-columns: 300px 1fr; }
  .mon-inspector { position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 90vw); background: var(--bg); box-shadow: -12px 0 36px rgb(0 0 0 / 0.14); z-index: 10; }
}

.mon-inbox { border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border)); border-radius: 11px; padding: 10px; background: color-mix(in srgb, var(--warn) 5%, var(--surface)); animation: mon-in 140ms ease-out; }
.mon-approval { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid var(--border); }
.mon-approval:first-of-type { border-top: 0; }
.mon-approval-main { text-align: left; background: none; border: 0; padding: 0; cursor: pointer; }
.mon-approval-title { font-weight: 600; }
.mon-approval-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mon-approval-summary { color: var(--muted); font-size: 12px; }
.mon-approval-actions { display: flex; gap: 6px; }
.mon-wait { font-size: 11px; font-weight: 600; color: var(--tone); }

.mon-run-group { display: flex; flex-direction: column; gap: 2px; }
.mon-run-group .mon-kicker { padding: 2px 4px 6px; }
.mon-run-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 7px 8px; border: 0; border-radius: 8px; background: none; cursor: pointer; }
.mon-run-row:hover { background: var(--hover); }
.mon-run-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); box-shadow: inset 2px 0 0 var(--brand); }
.mon-run-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-run-when { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }

.mon-panel { border: 1px solid var(--border); border-radius: 11px; background: var(--surface); padding: 12px 14px; margin-bottom: 12px; animation: mon-in 140ms ease-out; }
.mon-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }

.mon-detail-head { display: flex; flex-direction: column; gap: 8px; }
.mon-detail-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mon-detail-workflow { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
.mon-detail-actions { display: flex; gap: 8px; }
.mon-runid { align-self: flex-start; background: none; border: 0; padding: 0; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--muted); }
.mon-runid:hover { color: var(--text); }
.mon-progress { display: flex; align-items: center; gap: 10px; }
.mon-progress-track { flex: 1; max-width: 320px; height: 5px; border-radius: 999px; background: color-mix(in srgb, var(--brand) 12%, transparent); overflow: hidden; }
.mon-progress-fill { height: 100%; border-radius: 999px; background: var(--brand); transition: width 300ms ease; }

.mon-tree { overflow-x: auto; }
.mon-tree-row { display: flex; align-items: center; gap: 2px; border-radius: 7px; }
.mon-tree-row:hover { background: var(--hover); }
.mon-tree-row.is-active { background: color-mix(in srgb, var(--brand) 9%, transparent); }
.mon-tree-chevron { width: 20px; flex: none; background: none; border: 0; cursor: pointer; color: var(--muted); text-align: center; }
.mon-tree-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: 5px 6px 5px 0; cursor: pointer; }
.mon-tree-glyph { flex: none; width: 14px; text-align: center; }
.mon-tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mon-tree-main .mon-pill { margin-left: auto; }

.mon-events-panel { display: flex; flex-direction: column; }
.mon-events { max-height: 300px; overflow-y: auto; font-size: 11px; }
.mon-event { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--border); align-items: baseline; }
.mon-event:last-child { border-bottom: 0; }
.mon-event-name { font-weight: 600; white-space: nowrap; }
.mon-event-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mon-inspector-title { font-weight: 700; margin: 4px 0 10px; }
.mon-meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0 0 12px; }
.mon-meta-grid dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.mon-meta-grid dd { margin: 0; overflow-wrap: anywhere; }
.mon-toolcalls { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 12px; }
.mon-toolcall { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); }
.mon-output { margin: 6px 0 0; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: auto; max-height: 45vh; overflow-y: auto; }
.mon-failure { border-color: color-mix(in srgb, var(--failed, #f87171) 45%, var(--border)); }

.mon-empty { color: var(--muted); text-align: center; padding: 28px 12px; display: flex; flex-direction: column; gap: 6px; }
.mon-empty-hero { padding-top: 18vh; }

@keyframes mon-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes mon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .mon-dot-pulse, .mon-panel, .mon-banner, .mon-inspector, .mon-inbox { animation: none; }
  * { transition-duration: 0.001ms !important; animation-duration: 0.001ms !important; }
}
`;

createGatewayReactRoot(<App />);
