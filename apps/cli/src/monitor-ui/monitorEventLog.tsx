/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useGatewayRunEvents } from "smithers-orchestrator/gateway-react";
import { asString, eventViewFor, formatEventLine } from "./monitorModel.ts";
import { Chip } from "./monitorShell.tsx";

// ---------------------------------------------------------------------------
// Live event log with follow mode: auto-scrolls while you stay near the
// bottom; scrolling up pauses following; the Follow chip re-engages it.
// ---------------------------------------------------------------------------

const FOLLOW_THRESHOLD_PX = 80;

type EventView = "notable" | "activity" | "all";

export function EventLog({ runId }: { runId: string }) {
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
        <Chip
          on={view === "notable"}
          onClick={() => setView("notable")}
          title="Node/run lifecycle, approvals, human requests"
        >
          Notable
        </Chip>
        <Chip
          on={view === "activity"}
          onClick={() => setView("activity")}
          title="Notable plus tool calls, agent output, frames, and token usage"
        >
          Activity
        </Chip>
        <Chip
          on={view === "all"}
          onClick={() => setView("all")}
          title="Every event, including heartbeats and session bookkeeping"
        >
          All
        </Chip>
        <Chip
          on={following}
          onClick={() => {
            setFollowing(true);
            const el = containerRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          title="Auto-scroll to new events"
        >
          {streaming ? "● " : ""}Follow
        </Chip>
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
