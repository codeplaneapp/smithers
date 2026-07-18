/** @jsxImportSource react */
import { useJsonApi } from "./monitorShared.tsx";
import { Chip } from "./monitorShell.tsx";
import { decisionEntriesOf, decisionTone, formatDecisionResolution, pendingDecisionCount, sortDecisions, summarizeDecisionValue } from "./monitorDecisionsModel.ts";

const terminal = new Set(["finished", "failed", "cancelled", "canceled"]);

export function DecisionsPanel({ runId, runStatus, onSelectNode }: { runId: string; runStatus?: string; onSelectNode: (node: { id: string; key: string; iteration?: number }) => void }) {
  const read = useJsonApi(`/v1/api/runs/${encodeURIComponent(runId)}/decisions`, terminal.has((runStatus ?? "").toLowerCase()) ? null : 5_000);
  const entries = sortDecisions(decisionEntriesOf(read.body));
  const pending = pendingDecisionCount(entries);
  return <section className="mon-panel mon-decisions" data-testid="monitor-decisions">
    <header className="mon-panel-head"><h2 className="mon-kicker">Decisions &amp; deviations</h2>{pending ? <span className="mon-chip">{pending} pending</span> : null}</header>
    {read.failed ? <div className="mon-empty" role="status">Couldn’t load decisions. Retrying…</div> : null}
    {read.loaded && entries.length === 0 ? <div className="mon-empty">No decisions recorded for this run</div> : null}
    {entries.map((entry, index) => <article className="mon-decision" key={`${entry.kind}-${entry.nodeId}-${entry.occurredAtMs}-${index}`}>
      <div><span className="mon-chip">{entry.kind}</span> <strong>{entry.title}</strong> <span className={`mon-pill tone-${decisionTone(entry.status)}`}><span className="mon-dot" aria-hidden />{entry.status}</span></div>
      <div className={`mon-dim tone-${decisionTone(entry.status)}`}>{formatDecisionResolution(entry)}</div>
      {entry.nodeId ? <Chip onClick={() => onSelectNode({ id: entry.nodeId!, key: entry.nodeId!, iteration: entry.iteration ?? undefined })}>node {entry.nodeId}{entry.iteration ? `#${entry.iteration}` : ""}</Chip> : null}
      <details><summary>Details</summary><pre className="mon-pre">{entry.kind === "memory" ? summarizeDecisionValue((entry.detail as any)?.valueJson ?? (entry.detail as any)?.value) : JSON.stringify(entry.detail, null, 2)}</pre></details>
    </article>)}
  </section>;
}
