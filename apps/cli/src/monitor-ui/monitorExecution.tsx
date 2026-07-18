/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { snapshotToGatewayRunNode, type DevToolsSnapshot } from "smithers-orchestrator/gateway-client";
import { useGatewayRpc, useGatewayRunTree } from "smithers-orchestrator/gateway-react";
import {
  asNumber,
  asString,
  autoExpandKeys,
  buildTimeline,
  clampFrameNo,
  formatDurationMs,
  frameScrubBounds,
  hasFailedDescendant,
  isRecord,
  nodeStateRowsOf,
  toneForStatus,
  treeNodeKey,
  type NodeStateRow,
  type TreeNodeLike,
} from "./monitorModel.ts";
import { Chip, ToneDot } from "./monitorShell.tsx";
import { Ago, StatusTag, useNowMs } from "./monitorShared.tsx";

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

export type TreeNode = TreeNodeLike & {
  name?: string;
  cardLabel?: string;
  kind?: string;
  iteration?: number;
  agent?: unknown;
  attempt?: number;
  maxAttempts?: number;
  toolCalls?: unknown;
  children?: TreeNode[] | null;
};

/** Accept the API's nodeId::iteration links even when DevTools' React key is structural. */
export function matchesAutoSelectNode(candidate: TreeNode, autoSelectNodeId: string): boolean {
  return candidate.id === autoSelectNodeId
    || treeNodeKey(candidate) === autoSelectNodeId
    || `${candidate.id ?? ""}::${candidate.iteration ?? 0}` === autoSelectNodeId;
}

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
    const match = (nodes as TreeNode[]).find((candidate) => matchesAutoSelectNode(candidate, autoSelectNodeId));
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
// Timeline: the run's task executions as a chronological flat list — loops
// unrolled into one row per (nodeId, iteration) — from the gateway's
// node-states route (the tree collection carries no timestamps). Polls every
// few seconds while the run is live; clicking a row selects that node in the
// inspector.
// ---------------------------------------------------------------------------

const TIMELINE_POLL_MS = 3_000;

function TimelinePanel({
  runId,
  live,
  selectedNode,
  onSelectNode,
}: {
  runId: string;
  live: boolean;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode) => void;
}) {
  const tree = useGatewayRunTree(runId);
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
  const now = useNowMs();
  const entries = useMemo(() => (rows ? buildTimeline(rows, now) : []), [rows, now]);
  // Prefer the real tree node (kind, agent, children intact) so the inspector
  // shows everything; a row the tree has not materialized yet falls back to a
  // minimal task node built from the state row.
  const selectEntry = (entry: ReturnType<typeof buildTimeline>[number]) => {
    const match = (tree.nodes as TreeNode[]).find(
      (candidate) => candidate.id === entry.nodeId && (candidate.iteration ?? 0) === entry.iteration,
    );
    onSelectNode(
      match ?? ({ id: entry.nodeId, iteration: entry.iteration, status: entry.state, kind: "task", name: entry.label ?? entry.nodeId } as TreeNode),
    );
  };
  if (rows === null) {
    return (
      <div className="mon-empty">
        {failed ? "Could not load the timeline — the gateway did not answer the node-states request." : "Loading timeline…"}
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

export function ExecutionPanel({
  runId,
  runStatus,
  selectedNode,
  onSelectNode,
  autoSelectNodeId,
  onAutoSelected,
}: {
  runId: string;
  runStatus: string | undefined;
  selectedNode: TreeNode | undefined;
  onSelectNode: (node: TreeNode | undefined) => void;
  autoSelectNodeId?: string;
  onAutoSelected?: () => void;
}) {
  const [scrubbing, setScrubbing] = useState(false);
  // null = pinned to the latest frame until the user actually scrubs.
  const [frame, setFrame] = useState<number | null>(null);
  const [asXml, setAsXml] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  // Reset scrub state when switching runs.
  const lastRunId = useRef(runId);
  if (lastRunId.current !== runId) {
    lastRunId.current = runId;
    if (scrubbing) setScrubbing(false);
    if (frame !== null) setFrame(null);
    if (showTimeline) setShowTimeline(false);
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
          <Chip onClick={() => onSelectNode(undefined)}>Clear selection</Chip>
        ) : null}
        <Chip
          on={scrubbing}
          data-testid="monitor-frames-chip"
          onClick={() => {
            setShowTimeline(false);
            if (scrubbing) goLive();
            else setScrubbing(true);
          }}
          title="Scrub the execution tree frame by frame instead of following it live"
        >
          Frames
        </Chip>
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
        <Chip
          on={showTimeline}
          data-testid="monitor-timeline-chip"
          onClick={() => {
            if (!showTimeline) goLive();
            setShowTimeline((value) => !value);
          }}
          title="Every task execution in the order it ran — loops unrolled, one row per iteration"
        >
          Timeline
        </Chip>
      </header>
      {scrubbing && !showTimeline ? (
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
      {showTimeline ? (
        <TimelinePanel
          runId={runId}
          live={toneForStatus(runStatus) === "running" || toneForStatus(runStatus) === "waiting"}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />
      ) : (
        <ExecutionTree
          runId={runId}
          selectedNodeKey={selectedNode ? treeNodeKey(selectedNode) : undefined}
          onSelectNode={onSelectNode}
          autoSelectNodeId={autoSelectNodeId}
          onAutoSelected={onAutoSelected}
          frameOverride={scrubbing ? { root: scrubTree, loading: scrubLoading } : undefined}
          asXml={asXml}
        />
      )}
    </section>
  );
}
