/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UseGatewayRunTreeResult } from "smithers-orchestrator/gateway-react";
import {
  ErrorBanner,
  MarkdownPreview,
  WorkflowSource,
  asArray,
  asString,
  buildChatLines,
  formatCount,
  formatStatus,
  fmtTime,
  logLineFromFrame,
  statusClass,
  useDialogFocusTrap,
  type EventFrame,
  type RunSummaryRow,
} from "./ddd-shared";

// Read run-tree nodes structurally — GatewayRunNode's fields aren't barrel-exported.
type RunNode = Record<string, unknown>;

function runWorkflow(run: RunSummaryRow): string {
  return asString(run.workflowKey ?? run.workflowName ?? run.workflow) || "docs-driven-development";
}

function runSearchBlob(run: RunSummaryRow): string {
  return [
    run.runId,
    runWorkflow(run),
    run.status,
    fmtTime(run.createdAtMs),
    run.createdAtMs ? new Date(run.createdAtMs).toISOString() : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function shortRunId(runId: string): string {
  return runId.length <= 24 ? runId : `${runId.slice(0, 12)}...${runId.slice(-8)}`;
}

function uniqueRunStatuses(runs: RunSummaryRow[]): string[] {
  return [...new Set(runs.map((run) => asString(run.status).trim()).filter(Boolean))].sort((left, right) =>
    formatStatus(left).localeCompare(formatStatus(right)),
  );
}

/** `smithers up --interactive` style streaming feed: every run event as a log line, auto-scrolled. */
function LiveLog({ events, streaming }: { events: EventFrame[]; streaming: boolean }) {
  const lines = events.map((frame) => logLineFromFrame(frame)).filter(Boolean) as Array<{
    seq: number;
    event: string;
    node: string;
    detail: string;
    tone: "ok" | "warn" | "bad" | "";
  }>;
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  return (
    <section className="card" data-testid="ddd-live-log">
      <div className="card-head">
        <h2>Live log</h2>
        <span className={`badge ${streaming ? "ok" : "muted"}`}>{streaming ? "live" : "idle"}</span>
      </div>
      {lines.length ? (
        <div className="livelog">
          {lines.map((line) => (
            <div className={`livelog-line${line.tone ? ` is-${line.tone}` : ""}`} key={line.seq}>
              <div className="livelog-main">
                <span className="livelog-event">{line.event}</span>
                {line.node ? <span className="livelog-node">{line.node}</span> : null}
                {line.detail ? <span className="livelog-detail">{line.detail}</span> : null}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : (
        <p>No events yet for this run.</p>
      )}
    </section>
  );
}

export type LiveTabProps = {
  runs: RunSummaryRow[];
  runsLoading: boolean;
  selectedRunId: string | undefined;
  selectedWorkflowKey?: string;
  onSelectRun: (runId: string) => void;
  runStatus: string | undefined;
  runTree: UseGatewayRunTreeResult;
  events: EventFrame[];
  eventsError?: Error;
  streaming: boolean;
  assetBase: string | undefined;
};

function mergeEvents(history: EventFrame[], live: EventFrame[]): EventFrame[] {
  const bySeq = new Map<number, EventFrame>();
  for (const frame of [...history, ...live]) {
    const seq = Number(frame.seq ?? 0);
    if (!Number.isFinite(seq)) continue;
    bySeq.set(seq, frame);
  }
  return [...bySeq.values()].sort((left, right) => Number(left.seq ?? 0) - Number(right.seq ?? 0));
}

// v1 ships no asset server: without ?assetBaseUrl there is no /run-events
// history endpoint, so we render live-streamed events only.
function usePersistedRunEvents(assetBase: string | undefined, runId: string | undefined) {
  const [events, setEvents] = useState<EventFrame[]>([]);
  const [error, setError] = useState<Error | undefined>();
  useEffect(() => {
    let alive = true;
    setEvents([]);
    setError(undefined);
    if (!assetBase || !runId) return;
    const url = `${assetBase}/run-events?runId=${encodeURIComponent(runId)}&limit=1000`;
    fetch(url)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`run events ${response.status}`))))
      .then((json: unknown) => {
        if (!alive) return;
        const rows =
          json && typeof json === "object" && Array.isArray((json as { events?: unknown }).events)
            ? (json as { events: EventFrame[] }).events
            : [];
        setEvents(rows);
      })
      .catch(() => {
        if (alive) {
          setEvents([]);
          setError(new Error("Saved run events could not be loaded from the asset server."));
        }
      });
    return () => {
      alive = false;
    };
  }, [assetBase, runId]);
  return { events, error };
}

function nodeLabel(node: RunNode): string {
  return asString(node.cardLabel) || asString(node.name) || asString(node.id);
}

/** Walk the tree and tally leaf/all node statuses into ok/running/failed buckets. */
function tallyNodeStatuses(root: RunNode | null): { done: number; running: number; failed: number; total: number } {
  const acc = { done: 0, running: 0, failed: 0, total: 0 };
  const visit = (node: RunNode) => {
    acc.total += 1;
    const tone = statusClass(asString(node.status));
    if (tone === "ok") acc.done += 1;
    else if (tone === "bad") acc.failed += 1;
    else if (asString(node.status)) acc.running += 1;
    for (const child of asArray(node.children) as RunNode[]) visit(child);
  };
  if (root) visit(root);
  return acc;
}

function Node({ node, onSelect }: { node: RunNode; onSelect: (node: RunNode) => void }) {
  const children = asArray(node.children) as RunNode[];
  const label = nodeLabel(node);
  const agent = asString(node.agent);
  const hasDetail = Boolean(asString(node.output) || asArray(node.toolCalls).length > 0 || asString(node.meta));
  return (
    <li>
      <button
        type="button"
        className="node-row"
        data-testid="ddd-node-row"
        onClick={() => onSelect(node)}
        title={hasDetail ? "View node output" : "View node detail"}
      >
        <span className={`badge ${statusClass(asString(node.status))}`} data-status={asString(node.status)}>
          {formatStatus(asString(node.status)) || "-"}
        </span>
        <span className="node-name">{label}</span>
        {agent ? <span className="pill">{agent}</span> : null}
        <span className="node-drill" aria-hidden="true">
          ›
        </span>
      </button>
      {children.length ? (
        <ul>
          {children.map((child, index) => (
            <Node key={asString(child.key ?? child.id) || `node:${index}`} node={child} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function NodeDetail({ node, onClose }: { node: RunNode; onClose: () => void }) {
  const modalRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocusTrap({ containerRef: modalRef, initialFocusRef: closeRef, onClose });
  const status = asString(node.status);
  const agent = asString(node.agent);
  const kind = asString(node.kind);
  const iteration = Number(node.iteration ?? 0);
  const output = asString(node.output);
  const meta = asString(node.meta);
  const toolCalls = asArray(node.toolCalls).filter(
    (call): call is Record<string, unknown> => !!call && typeof call === "object",
  );
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddd-node-detail-title"
        tabIndex={-1}
        data-testid="ddd-node-detail"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">
              {kind || "node"}
              {iteration > 0 ? ` · attempt ${iteration + 1}` : ""}
            </span>
            <h2 id="ddd-node-detail-title">{nodeLabel(node)}</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div className="meta-row">
          {status ? <span className={`badge ${statusClass(status)}`}>{formatStatus(status)}</span> : null}
          {agent ? <span className="pill">{agent}</span> : null}
          <span className="pill muted" title={asString(node.id)}>
            {asString(node.id)}
          </span>
        </div>
        {toolCalls.length ? (
          <div className="list-block">
            <strong>Tool calls</strong>
            <div className="meta-row">
              {toolCalls.map((call, index) => (
                <span className="pill" key={`tool:${index}`}>
                  {asString(call.name ?? call.tool ?? call.kind) || "tool"}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {output ? (
          <div className="list-block">
            <strong>Output</strong>
            <pre className="source">{output}</pre>
          </div>
        ) : meta ? (
          <div className="list-block">
            <strong>Detail</strong>
            <p>{meta}</p>
          </div>
        ) : (
          <p className="empty">No captured output for this node yet.</p>
        )}
      </section>
    </div>
  );
}

export function LiveTab(props: LiveTabProps) {
  const { runs, runsLoading, selectedRunId, runTree, events, streaming } = props;
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedNode, setSelectedNode] = useState<RunNode | null>(null);
  const nodeTally = useMemo(() => tallyNodeStatuses((runTree.root as unknown as RunNode) ?? null), [runTree.root]);
  const persistedEvents = usePersistedRunEvents(props.assetBase, selectedRunId);
  const allEvents = useMemo(() => mergeEvents(persistedEvents.events, events), [persistedEvents.events, events]);
  const chatLines = useMemo(() => buildChatLines(allEvents), [allEvents]);
  const statuses = useMemo(() => uniqueRunStatuses(runs), [runs]);
  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilter !== "all" && asString(run.status) !== statusFilter) return false;
      return !needle || runSearchBlob(run).includes(needle);
    });
  }, [runs, query, statusFilter]);
  const filtersActive = query.trim().length > 0 || statusFilter !== "all";
  const countLabel = runsLoading
    ? "Loading"
    : filteredRuns.length === runs.length
      ? formatCount(runs.length, "run")
      : `${formatCount(filteredRuns.length, "run")} of ${formatCount(runs.length, "run")}`;

  return (
    <div className="live pane" data-testid="ddd-live-tab">
      <div className="runlist" data-testid="ddd-run-list">
        <div className="card-head">
          <h2>Docs runs</h2>
          <span className="pill">{countLabel}</span>
        </div>
        <div className="run-filters" role="search" aria-label="Run filters">
          <label className="filter-field">
            <span>Search</span>
            <input
              className="search-input"
              type="search"
              value={query}
              data-testid="ddd-run-search"
              placeholder="Run id, workflow, status, date"
              onInput={(event) => setQuery(event.currentTarget.value)}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label className="filter-field">
            <span>Status</span>
            <select
              className="select"
              value={statusFilter}
              data-testid="ddd-run-status-filter"
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
            >
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {formatStatus(status)}
                </option>
              ))}
            </select>
          </label>
          {filtersActive ? (
            <button
              className="button"
              type="button"
              onClick={() => {
                setQuery("");
                setStatusFilter("all");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
        {filteredRuns.length ? (
          filteredRuns.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={run.runId === selectedRunId ? "run-row is-active" : "run-row"}
              onClick={() => props.onSelectRun(run.runId)}
            >
              <span className="rid" title={run.runId}>
                {shortRunId(run.runId)}
              </span>
              <div className="meta-row">
                <span className={`badge ${statusClass(run.status)}`}>{formatStatus(run.status) || "-"}</span>
                <span className="pill">{runWorkflow(run)}</span>
                {run.createdAtMs ? <span className="pill">{fmtTime(run.createdAtMs)}</span> : null}
              </div>
            </button>
          ))
        ) : (
          <p>
            {runsLoading
              ? "Loading runs..."
              : filtersActive
                ? "No runs match the current filters."
                : "No docs-driven-development runs yet. Dispatch agents from the Docs tab."}
          </p>
        )}
      </div>

      <div className="scroll">
        {!selectedRunId ? (
          <section className="card">
            <p>Select a run to see its chat log, the smithers script, and the live node tree.</p>
          </section>
        ) : (
          <>
            <ErrorBanner title="Live data issue" errors={[props.eventsError, runTree.error, persistedEvents.error]} />

            <section className="card" data-testid="ddd-run-tree">
              <div className="card-head">
                <h2>Run node tree</h2>
                <span className={`badge ${statusClass(props.runStatus ?? runTree.status)}`}>
                  {formatStatus(props.runStatus ?? runTree.status) || "-"}
                </span>
              </div>
              {nodeTally.total > 0 ? (
                <div className="tree-tally" data-testid="ddd-tree-tally">
                  {nodeTally.done ? <span className="badge ok">{nodeTally.done} done</span> : null}
                  {nodeTally.running ? <span className="badge warn">{nodeTally.running} running</span> : null}
                  {nodeTally.failed ? <span className="badge bad">{nodeTally.failed} failed</span> : null}
                  <span className="pill muted">{formatCount(nodeTally.total, "node")}</span>
                </div>
              ) : null}
              <div className="nodetree">
                {runTree.root ? (
                  <ul>
                    <Node node={runTree.root as unknown as RunNode} onSelect={setSelectedNode} />
                  </ul>
                ) : (
                  <p className="empty">{runTree.isLoading ? "Loading tree..." : "No node tree for this run yet."}</p>
                )}
              </div>
            </section>

            <section className="card" data-testid="ddd-chat-log">
              <div className="card-head">
                <h2>Chat logs</h2>
                <span className={`badge ${streaming ? "ok" : "muted"}`}>{streaming ? "live" : "idle"}</span>
              </div>
              {chatLines.length ? (
                <div className="chat">
                  {chatLines.map((line, index) => (
                    <div
                      className={`chat-line chat-kind-${line.kind}${line.role ? ` chat-role-${line.role}` : ""}`}
                      key={`${line.kind}:${line.who}:${index}`}
                    >
                      <span className="who">{line.who}</span>
                      {line.kind === "message" ? <MarkdownPreview markdown={line.text} /> : <pre>{line.text}</pre>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty">No agent chat output yet for this run.</p>
              )}
            </section>

            <LiveLog events={allEvents} streaming={streaming} />

            <WorkflowSource workflowKey={props.selectedWorkflowKey} />
          </>
        )}
      </div>
      {selectedNode ? <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} /> : null}
    </div>
  );
}
