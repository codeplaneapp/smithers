/** @jsxImportSource react */
import { useJsonApi } from "./monitorShared.tsx";
import { Chip } from "./monitorShell.tsx";
import { isTerminalStatus } from "./monitorModel.ts";
import { decisionEntriesOf, decisionTone, formatDecisionResolution, pendingDecisionCount, sortDecisions, summarizeDecisionValue } from "./monitorDecisionsModel.ts";

export function DecisionsPanel({ runId, runStatus, onSelectNode }: { runId: string; runStatus?: string; onSelectNode: (node: { id: string; key: string; iteration?: number }) => void }) {
  const read = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/decisions`, isTerminalStatus(runStatus) ? null : 5_000);
  const entries = sortDecisions(decisionEntriesOf(read.body));
  const pending = pendingDecisionCount(entries);
  // Empty collapses to a quiet single row — loading or loaded, never a
  // reserved void with a lone header.
  if (!read.failed && entries.length === 0) {
    return <section className="mon-panel mon-panel-quiet mon-decisions" data-testid="monitor-decisions">
      <h2 className="mon-kicker">Decisions</h2>
      <span className="mon-dim">{read.loaded ? "None yet" : "loading…"}</span>
    </section>;
  }
  return <section className="mon-panel mon-decisions" data-testid="monitor-decisions">
    <header className="mon-panel-head"><h2 className="mon-kicker">Decisions &amp; deviations</h2>{pending ? <span className="mon-chip">{pending} pending</span> : null}</header>
    {read.failed ? <div className="mon-empty" role="status">Couldn’t load decisions. Retrying…</div> : null}
    {entries.map((entry, index) => <article className="mon-decision" key={`${entry.kind}-${entry.nodeId}-${entry.occurredAtMs}-${index}`}>
      <span className="mon-chip">{entry.kind}</span>
      <strong className="mon-decision-title">{entry.title}</strong>
      <span className={`mon-pill tone-${decisionTone(entry.status)}`}><span className="mon-dot" aria-hidden />{entry.status}</span>
      <div className={`mon-decision-resolution mon-dim tone-${decisionTone(entry.status)}`}>{formatDecisionResolution(entry)}</div>
      <div className="mon-decision-links">
        {entry.nodeId ? <Chip onClick={() => onSelectNode({ id: entry.nodeId!, key: entry.nodeId!, iteration: entry.iteration ?? undefined })}>node {entry.nodeId}{entry.iteration ? `#${entry.iteration}` : ""}</Chip> : null}
        <details><summary>Details</summary><pre className="mon-pre">{entry.kind === "memory" ? summarizeDecisionValue((entry.detail as any)?.valueJson ?? (entry.detail as any)?.value) : JSON.stringify(entry.detail, null, 2)}</pre></details>
      </div>
    </article>)}
  </section>;
}
