/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useGatewayRpc, useGatewayRunEvents } from "smithers-orchestrator/gateway-react";
import { formatRecapAge, latestNotableSeqOf, parseRecapSummary, shouldRefreshRecap } from "./monitorRecapModel.ts";
import { isTerminalStatus } from "./monitorModel.ts";

export function RecapPanel({ runId, status }: { runId: string; status?: string }) {
  const { events } = useGatewayRunEvents(runId, { maxEvents: 500 });
  const recap = useGatewayRpc("runRecap", { runId }, { enabled: !!runId });
  const lastAttempt = useRef(0);
  const failures = useRef(0);
  const [pollTick, setPollTick] = useState(0);
  const live = !isTerminalStatus(status);
  useEffect(() => {
    if (!live) return;
    // Event streams can go quiet while a run is still active; retain a bounded
    // live poll so the watermark advances even when nothing causes a render.
    const timer = setInterval(() => setPollTick((tick) => tick + 1), 180_000);
    return () => clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (recap.data) { failures.current = 0; lastAttempt.current = Date.now(); }
  }, [recap.data]);
  useEffect(() => {
    // Each failed fetch is a fresh Error instance; count them so the refresh
    // gate below can back off instead of hammering a failing Gateway whenever
    // live events sit above the last recap's watermark.
    if (recap.error) failures.current += 1;
  }, [recap.error]);
  useEffect(() => {
    const data: any = recap.data;
    if (shouldRefreshRecap({ lastToSeq: data?.toSeq, latestNotableSeq: latestNotableSeqOf(events), lastFetchedAtMs: lastAttempt.current, lastAttemptAtMs: lastAttempt.current, consecutiveFailures: failures.current, nowMs: Date.now(), live, inFlight: recap.loading })) {
      lastAttempt.current = Date.now();
      void recap.refetch();
    }
  }, [events, live, recap, pollTick]);
  const data: any = recap.data;
  // A transient RPC failure keeps the last recap on screen; only a failure
  // with nothing to show yet hides the panel. Loading is two shimmer bars,
  // never a full empty panel.
  if (!data && recap.loading) {
    return (
      <section className="mon-panel" data-testid="monitor-recap-loading">
        <header className="mon-panel-head"><h2 className="mon-kicker">Run recap</h2></header>
        <div className="mon-skeleton" />
        <div className="mon-skeleton" />
      </section>
    );
  }
  if (!data) return null;
  const history = Array.isArray(data.history) ? data.history.slice(1) : [];
  const view = parseRecapSummary(String(data.summary ?? ""));
  const byline = data.source === "agent" ? `Narrated by ${data.agentId ?? "agent"}` : "Facts recap";
  return <section className="mon-panel" data-testid="monitor-recap">
    <header className="mon-panel-head">
      <h2 className="mon-kicker">Run recap</h2>
      <span className="mon-dim">{byline} · {formatRecapAge(data.generatedAtMs)}</span>
    </header>
    <div className="mon-recap-summary">{view.lede}</div>
    {view.notable.map((fact) => (
      <div className="mon-recap-line" key={fact.label}>
        <span className="mon-dim">{fact.label}</span> {fact.value}
      </div>
    ))}
    {view.factsLine ? <div className="mon-recap-facts">{view.factsLine}</div> : null}
    {history.length ? <details><summary>Earlier recaps ({history.length})</summary>{history.map((entry: any) => <div key={entry.toSeq} className="mon-recap-history">{entry.summary}</div>)}</details> : null}
  </section>;
}
