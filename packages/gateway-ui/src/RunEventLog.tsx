/** @jsxImportSource react */
import { useEffect, useRef, type CSSProperties } from "react";
import { useGatewayRunEvents } from "@smithers-orchestrator/gateway-react";
import { Marker } from "@smithers-orchestrator/ui";
import { theme } from "./theme";

export type RunEventLogProps = {
  /** The run to stream events for. When undefined, renders an empty state. */
  runId: string | undefined;
  /** Cap the number of frames kept in memory. Default 500. */
  maxEvents?: number;
  /** Auto-scroll to the newest frame as it arrives. Default true. */
  follow?: boolean;
  className?: string;
  style?: CSSProperties;
};

// Cap each log line's payload preview so a single huge frame can't bloat the
// DOM; the full payload is inspectable via NodeOutputView.
const PAYLOAD_PREVIEW_CHARS = 200;

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
    ? value as Record<string, unknown>
    : undefined;
}

function markerState(event: string, payload: unknown, streaming: boolean) {
  const record = recordOf(payload);
  const payloadType = typeof record?.type === "string" ? record.type : "";
  const eventType = payloadType || event;
  const normalized = eventType.toLowerCase().replaceAll(/[^a-z]/g, "");
  const status = typeof record?.status === "string"
    ? record.status
    : typeof record?.state === "string"
      ? record.state
      : "";
  const heartbeat = normalized === "taskheartbeat";
  const statusRow = normalized.includes("status") || normalized.includes("state") || status !== "";
  if (!heartbeat && !statusRow) return null;
  const active = ["active", "in-progress", "in_progress", "pending", "queued", "running", "waiting"]
    .includes(status.toLowerCase());
  return { shimmer: streaming && (heartbeat || active) };
}

/**
 * A live, scrolling event log for a run. Streams {@link useGatewayRunEvents} and
 * renders one line per frame (seq · event · payload summary). Auto-follows the
 * tail. This is the lowest-level run view — pair it with {@link RunList} to pick
 * a run.
 */
export function RunEventLog({
  runId,
  maxEvents = 500,
  follow = true,
  className,
  style,
}: RunEventLogProps) {
  const { events, error, streaming } = useGatewayRunEvents(runId, { maxEvents });
  const endRef = useRef<HTMLDivElement | null>(null);
  const latestSeq = events[events.length - 1]?.seq;

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [latestSeq, follow]);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflow: "auto",
        padding: 10,
        background: theme.bg,
        borderRadius: theme.radius,
        border: `1px solid ${theme.border}`,
        fontFamily: theme.fontMono,
        fontSize: 12,
        color: theme.text,
        ...style,
      }}
    >
      {!runId ? (
        <div style={{ color: theme.textDim }}>Select a run to stream its events.</div>
      ) : null}
      {error ? <div style={{ color: theme.danger }}>{error.message}</div> : null}
      {runId && events.length === 0 && !error ? (
        <div style={{ color: theme.textDim }}>
          {streaming ? "Waiting for events…" : "No events."}
        </div>
      ) : null}
      {events.map((frame) => {
        const marker = markerState(frame.event, frame.payload, streaming);
        const seq = String(frame.seq).padStart(4, "0");
        const detail = summarize(frame.payload);
        return marker ? (
          <Marker
            key={frame.seq}
            variant="status"
            live
            shimmer={marker.shimmer}
            data-seq={frame.seq}
          >
            {[seq, frame.event, detail].filter(Boolean).join("  ")}
          </Marker>
        ) : (
          <div key={frame.seq} style={{ display: "flex", gap: 8, whiteSpace: "pre-wrap" }}>
            <span style={{ color: theme.textDim, flexShrink: 0 }}>{seq}</span>
            <span style={{ color: theme.accent, flexShrink: 0 }}>{frame.event}</span>
            <span style={{ color: theme.textDim }}>{detail}</span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
