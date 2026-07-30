/** @jsxImportSource react */
import { useEffect, useInsertionEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useGatewayRunEvents } from "@smithers-orchestrator/gateway-react";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { Badge, type BadgeProps, Button, EmptyState } from "@smithers-orchestrator/ui";
import { ensureGatewayUiStyles, theme } from "./theme";

export type RunEventLogProps = {
  /** The run to stream events for. When undefined, renders an empty state. */
  runId: string | undefined;
  /** Cap the number of frames kept in memory. Default 500. */
  maxEvents?: number;
  /** Auto-scroll to the newest frame as it arrives. Default true. */
  follow?: boolean;
  /**
   * Called when an event row that carries a `nodeId` is clicked. Wire it to a
   * {@link NodeChatStream}/{@link NodeOutputView} to open that node's live
   * transcript or output. Rows without a nodeId are not selectable.
   */
  onSelectNode?: (nodeId: string) => void;
  /** The currently selected nodeId — its rows are highlighted. */
  selectedNodeId?: string;
  /**
   * Show every `TaskHeartbeat` frame individually instead of coalescing
   * consecutive per-node heartbeats into one de-emphasized row. Default false;
   * a toolbar toggle flips it at runtime.
   */
  showAllHeartbeats?: boolean;
  className?: string;
  style?: CSSProperties;
};

// Cap each log line's payload preview so a single huge frame can't bloat the
// DOM; the full payload is inspectable via the per-row JSON toggle.
const PAYLOAD_PREVIEW_CHARS = 200;

/**
 * Compact one-line preview of a frame payload (used as the fallback summary and
 * kept exported for callers that render their own rows).
 */
export function summarize(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    const json = JSON.stringify(payload);
    return json.length > PAYLOAD_PREVIEW_CHARS ? `${json.slice(0, PAYLOAD_PREVIEW_CHARS)}…` : json;
  } catch {
    return "";
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// The `runEvents` collection hands the hook FLAT rows — `frame.event` is the
// lifecycle name and `frame.payload.nodeId` the node — but the resilient raw
// stream some hosts feed instead NESTS it: a generic wrapper in `frame.event`
// with the real name at `frame.payload.event` and the node at
// `frame.payload.payload.nodeId`. Read both shapes so a row renders correctly
// whichever layer produced it.
const GENERIC_EVENT_WRAPPERS = new Set(["event", "run.event", "node.event", "task.event", "agent.event"]);

/** The lifecycle/kind name for a frame (e.g. "NodeFinished", "TaskHeartbeat"). */
export function eventKind(frame: Pick<GatewayEventFrame, "event" | "payload">): string {
  const payload = recordOf(frame.payload);
  const direct = stringOf(frame.event);
  if (direct && !GENERIC_EVENT_WRAPPERS.has(direct)) return direct;
  const nested = payload ? stringOf(payload.event) : undefined;
  const type = payload ? stringOf(payload.type) : undefined;
  return nested ?? type ?? direct ?? "event";
}

/** The nodeId a frame belongs to, across the flat and nested payload shapes. */
export function eventNodeId(frame: Pick<GatewayEventFrame, "payload">): string | undefined {
  const payload = recordOf(frame.payload);
  if (!payload) return undefined;
  const direct = stringOf(payload.nodeId);
  if (direct) return direct;
  const inner = recordOf(payload.payload);
  return inner ? stringOf(inner.nodeId) : undefined;
}

function eventNumber(frame: Pick<GatewayEventFrame, "payload">, key: string): number {
  const payload = recordOf(frame.payload);
  if (!payload) return 0;
  const direct = payload[key];
  if (typeof direct === "number") return direct;
  const inner = recordOf(payload.payload);
  const nested = inner ? inner[key] : undefined;
  return typeof nested === "number" ? nested : 0;
}

function eventError(frame: Pick<GatewayEventFrame, "payload">): string | undefined {
  const payload = recordOf(frame.payload);
  if (!payload) return undefined;
  const inner = recordOf(payload.payload);
  const candidate = payload.error ?? payload.message ?? inner?.error ?? inner?.message;
  if (typeof candidate === "string") return candidate || undefined;
  const record = recordOf(candidate);
  return record ? stringOf(record.message) : undefined;
}

export type EventTone =
  | "failed"
  | "ok"
  | "running"
  | "waiting"
  | "queued"
  | "cancelled"
  | "heartbeat"
  | "agent"
  | "neutral";

/** Map a lifecycle/kind name to a severity tone (drives the badge + row chrome). */
export function kindTone(kind: string): EventTone {
  const k = kind.toLowerCase();
  if (k.includes("heartbeat")) return "heartbeat";
  if (k.includes("fail") || k.includes("error")) return "failed";
  if (k.includes("cancel") || k.includes("skip")) return "cancelled";
  if (k.includes("finish") || k.includes("complet") || k.includes("succe") || k.includes("done")) {
    return "ok";
  }
  if (k.includes("start") || k.includes("resum") || k.includes("retry") || k.includes("running")) {
    return "running";
  }
  if (k.includes("approval") || k.includes("waiting") || k.includes("pause") || k.includes("timer")) {
    return "waiting";
  }
  if (k.includes("pending") || k.includes("queued")) return "queued";
  if (k.includes("agent")) return "agent";
  return "neutral";
}

const TONE_BADGE_VARIANT: Record<EventTone, NonNullable<BadgeProps["variant"]>> = {
  failed: "destructive",
  ok: "success",
  running: "default",
  waiting: "warning",
  queued: "muted",
  cancelled: "muted",
  heartbeat: "muted",
  agent: "secondary",
  neutral: "outline",
};

/** A human one-line summary of a frame ("audit-docs finished", "flaky failed: …"). */
export function summarizeEvent(frame: Pick<GatewayEventFrame, "event" | "payload">): string {
  const kind = eventKind(frame);
  const tone = kindTone(kind);
  const node = eventNodeId(frame);
  const subject = node ?? "run";
  switch (tone) {
    case "failed": {
      const err = eventError(frame);
      return `${subject} failed${err ? `: ${err}` : ""}`;
    }
    case "ok":
      return `${subject} finished`;
    case "running": {
      const verb = kind.toLowerCase().includes("retry") ? "retrying" : "started";
      return `${subject} ${verb}`;
    }
    case "waiting":
      return `${subject} waiting`;
    case "queued":
      return `${subject} queued`;
    case "cancelled":
      return `${subject} cancelled`;
    case "heartbeat":
      return `${subject} · heartbeat`;
    case "agent":
      return node ? `${node} agent activity` : "agent activity";
    default:
      return summarize(frame.payload) || (node ? `${node} · ${kind}` : kind);
  }
}

type LogRow = {
  key: string;
  /** The representative frame (the last one, for a coalesced heartbeat group). */
  frame: GatewayEventFrame;
  kind: string;
  tone: EventTone;
  nodeId: string | undefined;
  iteration: number;
  attempt: number;
  summary: string;
  /** >1 when this row coalesces consecutive per-node heartbeats. */
  count: number;
};

function toRow(frame: GatewayEventFrame, count: number): LogRow {
  const kind = eventKind(frame);
  return {
    key: `ev:${frame.seq}`,
    frame,
    kind,
    tone: kindTone(kind),
    nodeId: eventNodeId(frame),
    iteration: eventNumber(frame, "iteration"),
    attempt: eventNumber(frame, "attempt"),
    summary: summarizeEvent(frame),
    count,
  };
}

/**
 * Fold frames into display rows. When `coalesceHeartbeats` is true, consecutive
 * `TaskHeartbeat` frames for the same node collapse into a single counted row so
 * a chatty agent does not bury its real lifecycle events.
 */
export function buildLogRows(frames: ReadonlyArray<GatewayEventFrame>, coalesceHeartbeats: boolean): LogRow[] {
  const rows: LogRow[] = [];
  for (const frame of frames) {
    const kind = eventKind(frame);
    const isHeartbeat = kindTone(kind) === "heartbeat";
    if (coalesceHeartbeats && isHeartbeat) {
      const nodeId = eventNodeId(frame);
      const last = rows[rows.length - 1];
      if (last && last.tone === "heartbeat" && last.nodeId === nodeId) {
        last.count += 1;
        last.frame = frame;
        continue;
      }
    }
    rows.push(toRow(frame, 1));
  }
  return rows;
}

function safeJson(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

// A child component so each row owns its own expand state — React hooks cannot
// be called per-list-item in the parent map.
function EventRow({
  row,
  selected,
  onSelectNode,
}: {
  row: LogRow;
  selected: boolean;
  onSelectNode?: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const seq = String(row.frame.seq).padStart(4, "0");
  const selectable = Boolean(row.nodeId && onSelectNode);
  const badgeLabel = row.count > 1 ? `${row.kind} ×${row.count}` : row.kind;

  return (
    <div
      className="gw-event-row"
      data-slot="event-row"
      data-kind={row.kind}
      data-tone={row.tone}
      data-node={row.nodeId}
      data-seq={row.frame.seq}
      data-active={selected ? "true" : undefined}
      data-heartbeat={row.tone === "heartbeat" ? "true" : undefined}
    >
      <div className="gw-event-row-head">
        {selectable ? (
          <button
            type="button"
            className="gw-event-row-main"
            data-selectable={selectable ? "true" : "false"}
            onClick={selectable ? () => onSelectNode!(row.nodeId!) : undefined}
          >
            <span className="gw-event-row-seq">{seq}</span>
            <Badge variant={TONE_BADGE_VARIANT[row.tone]} style={{ flexShrink: 0 }}>
              {badgeLabel}
            </Badge>
            {row.nodeId ? <span className="gw-event-row-chip">{row.nodeId}</span> : null}
            {row.iteration > 0 || row.attempt > 1 ? (
              <span className="gw-event-row-meta">
                {row.iteration > 0 ? `iter ${row.iteration}` : ""}
                {row.iteration > 0 && row.attempt > 1 ? " · " : ""}
                {row.attempt > 1 ? `try ${row.attempt}` : ""}
              </span>
            ) : null}
            <span className="gw-event-row-summary">{row.summary}</span>
          </button>
        ) : (
          <div className="gw-event-row-main" data-selectable="false">
            <span className="gw-event-row-seq">{seq}</span>
            <Badge variant={TONE_BADGE_VARIANT[row.tone]} style={{ flexShrink: 0 }}>
              {badgeLabel}
            </Badge>
            {row.nodeId ? <span className="gw-event-row-chip">{row.nodeId}</span> : null}
            {row.iteration > 0 || row.attempt > 1 ? (
              <span className="gw-event-row-meta">
                {row.iteration > 0 ? `iter ${row.iteration}` : ""}
                {row.iteration > 0 && row.attempt > 1 ? " · " : ""}
                {row.attempt > 1 ? `try ${row.attempt}` : ""}
              </span>
            ) : null}
            <span className="gw-event-row-summary">{row.summary}</span>
          </div>
        )}
        <button
          type="button"
          className="gw-event-row-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide event payload" : "Show event payload"}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "−" : "{ }"}
        </button>
      </div>
      {expanded ? (
        <pre className="gw-event-row-json" data-slot="event-json">
          {safeJson(row.frame.payload)}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * A live, structured event log for a run. Streams {@link useGatewayRunEvents}
 * and renders one row per frame: a severity-tinted kind badge, a compact nodeId
 * chip, iteration/attempt when set, a human one-line summary, and a per-row
 * toggle that reveals the full JSON payload. Failures are visually prominent and
 * consecutive per-node `TaskHeartbeat` frames coalesce into one de-emphasized
 * row (toggle in the toolbar to show them all). Pass `onSelectNode` to make node
 * rows open that node's live chat/output (see {@link NodeChatStream}). Auto-
 * follows the tail; pair with {@link RunList} to pick a run.
 */
export function RunEventLog({
  runId,
  maxEvents = 500,
  follow = true,
  onSelectNode,
  selectedNodeId,
  showAllHeartbeats = false,
  className,
  style,
}: RunEventLogProps) {
  useInsertionEffect(ensureGatewayUiStyles, []);
  const { events, error, streaming } = useGatewayRunEvents(runId, { maxEvents, includeHeartbeats: true });
  const [showAll, setShowAll] = useState(showAllHeartbeats);
  const [dismissedError, setDismissedError] = useState<string>();
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // At-bottom gating (the MessageScroller pattern): auto-scroll only while the
  // reader is at the tail; a scrolled-up reader gets a jump button instead of
  // being yanked to the newest event. Starts true so the initial tail-follow
  // and zero-height (unmeasurable) viewports behave as before.
  const atBottomRef = useRef(true);
  const [jumpVisible, setJumpVisible] = useState(false);
  const latestSeq = events[events.length - 1]?.seq;

  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
    atBottomRef.current = atBottom;
    if (atBottom) setJumpVisible(false);
  };

  useEffect(() => {
    if (!error) setDismissedError(undefined);
  }, [error]);

  useEffect(() => {
    if (!follow) return;
    if (atBottomRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    } else if (latestSeq !== undefined) {
      setJumpVisible(true);
    }
  }, [latestSeq, follow]);

  const jumpToLatest = () => {
    atBottomRef.current = true;
    setJumpVisible(false);
    endRef.current?.scrollIntoView({ block: "end" });
  };

  const rows = useMemo(() => buildLogRows(events, !showAll), [events, showAll]);
  const heartbeatFrames = useMemo(
    () => events.filter((frame) => kindTone(eventKind(frame)) === "heartbeat").length,
    [events],
  );

  let body: ReactNode;
  if (!runId) {
    body = <EmptyState description="Select a run to stream its events." />;
  } else if (error && events.length === 0) {
    body = <EmptyState title="Event stream failed" description={error.message} />;
  } else if (events.length === 0) {
    body = <EmptyState description={streaming ? "Waiting for events…" : "No events."} />;
  } else {
    body = (
      <div className="gw-event-log-body">
        <div className="gw-event-rows" ref={scrollerRef} onScroll={handleScroll}>
          {rows.map((row) => (
            <EventRow
              key={row.key}
              row={row}
              selected={Boolean(row.nodeId) && row.nodeId === selectedNodeId}
              onSelectNode={onSelectNode}
            />
          ))}
          <div ref={endRef} />
        </div>
        {error && error.message !== dismissedError ? (
          <div
            data-slot="run-event-log-error"
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              borderTop: `1px solid ${theme.dangerBorder}`,
              background: theme.dangerSoft,
              color: theme.danger,
              fontFamily: theme.fontSans,
              fontSize: 12,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Event stream interrupted. {error.message}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss event stream error"
              onClick={() => setDismissedError(error.message)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        {jumpVisible ? (
          <button type="button" className="gw-event-jump" onClick={jumpToLatest}>
            <span aria-hidden="true">↓</span> Jump to latest
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={["gw-event-log", className].filter(Boolean).join(" ")} data-slot="run-event-log" style={style}>
      <div className="gw-event-log-toolbar">
        <span className="gw-event-log-count">
          {runId ? `${events.length} event${events.length === 1 ? "" : "s"}` : "no run"}
        </span>
        <span className="gw-event-log-toolbar-spacer" />
        {heartbeatFrames > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll((prev) => !prev)} aria-pressed={showAll}>
            {showAll ? "Coalesce heartbeats" : `Show all heartbeats (${heartbeatFrames})`}
          </Button>
        ) : null}
      </div>
      {body}
    </div>
  );
}
