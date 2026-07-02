/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UseGatewayRunTreeResult } from "smithers-orchestrator/gateway-react";
import {
  WorkflowSource,
  asArray,
  asString,
  buildChatLines,
  formatStatus,
  fmtTime,
  logLineFromFrame,
  statusClass,
  type EventFrame,
  type RunSummaryRow,
} from "./ddd-shared";

// Read run-tree nodes structurally — GatewayRunNode's fields aren't barrel-exported.
type RunNode = Record<string, unknown>;

/** `smithers up --interactive` style streaming feed: every run event as a log line, auto-scrolled. */
function LiveLog({ events, streaming }: { events: EventFrame[]; streaming: boolean }) {
  const lines = events.map((frame) => logLineFromFrame(frame)).filter(Boolean) as Array<{
    seq: number;
    event: string;
    node: string;
    detail: string;
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
            <div className="livelog-line" key={line.seq}>
              <span className="livelog-event">{line.event}</span>
              {line.node ? <span className="livelog-node">{line.node}</span> : null}
              {line.detail ? <span className="livelog-detail">{line.detail}</span> : null}
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
  onSelectRun: (runId: string) => void;
  runStatus: string | undefined;
  runTree: UseGatewayRunTreeResult;
  events: EventFrame[];
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
  useEffect(() => {
    let alive = true;
    setEvents([]);
    if (!assetBase || !runId) return;
    const url = `${assetBase}/run-events?runId=${encodeURIComponent(runId)}&limit=1000`;
    fetch(url)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`run events ${response.status}`))))
      .then((json: unknown) => {
        if (!alive) return;
        const rows = json && typeof json === "object" && Array.isArray((json as { events?: unknown }).events)
          ? ((json as { events: EventFrame[] }).events)
          : [];
        setEvents(rows);
      })
      .catch(() => {
        if (alive) setEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [assetBase, runId]);
  return events;
}

function Node({ node }: { node: RunNode }) {
  const children = asArray(node.children) as RunNode[];
  const label = asString(node.cardLabel) || asString(node.name) || asString(node.id);
  const agent = asString(node.agent);
  return (
    <li>
      <div className="node-row">
        <span className={`badge ${statusClass(asString(node.status))}`} data-status={asString(node.status)}>
          {formatStatus(asString(node.status)) || "-"}
        </span>
        <span className="node-name">{label}</span>
        {agent ? <span className="pill">{agent}</span> : null}
      </div>
      {children.length ? <ul>{children.map((child) => <Node key={asString(child.id)} node={child} />)}</ul> : null}
    </li>
  );
}

export function LiveTab(props: LiveTabProps) {
  const { runs, runsLoading, selectedRunId, runTree, events, streaming } = props;
  const persistedEvents = usePersistedRunEvents(props.assetBase, selectedRunId);
  const allEvents = useMemo(() => mergeEvents(persistedEvents, events), [persistedEvents, events]);
  const chatLines = useMemo(() => buildChatLines(allEvents), [allEvents]);

  return (
    <div className="live pane" data-testid="ddd-live-tab">
      <div className="runlist" data-testid="ddd-run-list">
        <div className="card-head"><h2>Docs runs</h2><span className="pill">{runs.length || (runsLoading ? "..." : 0)}</span></div>
        {runs.length ? (
          runs.map((run) => (
            <button
              key={run.runId}
              type="button"
              className={run.runId === selectedRunId ? "run-row is-active" : "run-row"}
              onClick={() => props.onSelectRun(run.runId)}
            >
              <span className="rid">{run.runId}</span>
              <div className="meta-row">
                <span className={`badge ${statusClass(run.status)}`}>{formatStatus(run.status) || "-"}</span>
                <span className="pill">{run.workflowKey ?? "docs-driven-development"}</span>
                {run.createdAtMs ? <span className="pill">{fmtTime(run.createdAtMs)}</span> : null}
              </div>
            </button>
          ))
        ) : (
          <p>{runsLoading ? "Loading runs..." : "No docs-driven-development runs yet. Dispatch agents from the Docs tab."}</p>
        )}
      </div>

      <div className="scroll">
        {!selectedRunId ? (
          <section className="card"><p>Select a run to see its chat log, the smithers script, and the live node tree.</p></section>
        ) : (
          <>
            <section className="card" data-testid="ddd-run-tree">
              <div className="card-head">
                <h2>Run node tree</h2>
                <span className={`badge ${statusClass(props.runStatus ?? runTree.status)}`}>{formatStatus(props.runStatus ?? runTree.status) || "-"}</span>
              </div>
              <div className="nodetree">
                {runTree.root ? <ul><Node node={runTree.root as unknown as RunNode} /></ul> : <p>{runTree.isLoading ? "Loading tree..." : "No node tree."}</p>}
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
                      <pre>{line.text}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No agent chat output yet for this run.</p>
              )}
            </section>

            <WorkflowSource />

            <LiveLog events={allEvents} streaming={streaming} />
          </>
        )}
      </div>
    </div>
  );
}
