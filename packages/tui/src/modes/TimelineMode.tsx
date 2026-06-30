import { useState, useMemo, useCallback } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunEvents, useActions } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import {
  classifyFrame,
  frameTickChar,
  frameTickColor,
  extractNodeSnapshots,
  nodeStatusGlyph,
  nodeStatusColor,
} from "./timelineUtils.ts";

const COMPACT_WIDTH = 100;

// ─── Tick Strip ──────────────────────────────────────────────────────────────

function TickStrip({
  events,
  selectedIdx,
  totalWidth,
  compact,
}: {
  events: GatewayEventFrame[];
  selectedIdx: number;
  totalWidth: number;
  compact: boolean;
}) {
  if (events.length === 0) {
    return (
      <box width="100%" height={3}>
        <text fg="#444444">{"  (no frames yet)"}</text>
      </box>
    );
  }

  const maxVisible = Math.max(4, totalWidth - 6);
  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, selectedIdx - half);
  const end = Math.min(events.length, start + maxVisible);
  const visible = events.slice(start, end);
  const selEvent = events[selectedIdx];

  const controls = compact
    ? "[j/k]move [⏎]jump [F]fork [W]rwd [L]live"
    : "[j/k] move  [⏎] jump  [F] fork  [W] rewind  [L] back to live";

  return (
    <box width="100%" height={3} flexDirection="column">
      {/* Info row: position + selected event name */}
      <box width="100%" height={1} flexDirection="row">
        <text fg="#444444">{`  frame ${selectedIdx + 1}/${events.length}`}</text>
        {selEvent ? (
          <text fg="#555555">{`  seq:${selEvent.seq}  ${selEvent.event}`}</text>
        ) : null}
      </box>

      {/* Tick marks row */}
      <box width="100%" height={1} flexDirection="row">
        <text fg="#333333">{"  "}</text>
        {visible.map((ev, i) => {
          const absIdx = start + i;
          const isSel = absIdx === selectedIdx;
          const marker = classifyFrame(ev);
          return (
            <text key={ev.seq} fg={frameTickColor(marker, isSel)}>
              {frameTickChar(marker, isSel)}
            </text>
          );
        })}
      </box>

      {/* Controls row */}
      <box width="100%" height={1}>
        <text fg="#444444">{`  ${controls}`}</text>
      </box>
    </box>
  );
}

// ─── Node Snapshot Panel ─────────────────────────────────────────────────────

function SnapshotPanel({
  events,
  upToSeq,
}: {
  events: GatewayEventFrame[];
  upToSeq: number;
}) {
  const snapshots = useMemo(
    () => extractNodeSnapshots(events, upToSeq),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, upToSeq],
  );

  return (
    <scrollbox width="100%" height="100%" scrollY>
      {snapshots.length === 0 ? (
        <text fg="#444444">{"  (no node activity at this frame)"}</text>
      ) : (
        snapshots.map((node) => (
          <box key={node.id} width="100%" height={1} flexDirection="row">
            <text fg={nodeStatusColor(node.status)}>{`  ${nodeStatusGlyph(node.status)} `}</text>
            <text fg="#cccccc">{node.name ?? node.id}</text>
            <text fg="#555555">{`  [${node.status}]`}</text>
          </box>
        ))
      )}
    </scrollbox>
  );
}

// ─── Main TimelineMode ────────────────────────────────────────────────────────

export function TimelineMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunEvents(runId, { maxEvents: 2000 });
  const actions = useActions();
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;

  // selectedIdx = -1 means "live" (show latest frame)
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const safeIdx =
    events.length === 0
      ? 0
      : selectedIdx < 0
        ? events.length - 1
        : Math.min(selectedIdx, events.length - 1);

  const isLive = selectedIdx < 0;
  const selectedEvent = events[safeIdx];

  const doRewind = useCallback(
    async (frameNo: number) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await actions.rewindRun({ runId, frameNo, confirm: true });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, actions, runId],
  );

  useKeyboard((e) => {
    const key = e.name;
    if (key === "j" || key === "right") {
      setSelectedIdx((prev) => {
        if (events.length === 0) return -1;
        const cur = prev < 0 ? events.length - 1 : prev;
        const next = cur + 1;
        return next >= events.length ? events.length - 1 : next;
      });
    } else if (key === "k" || key === "left") {
      setSelectedIdx((prev) => {
        if (events.length === 0) return -1;
        const cur = prev < 0 ? events.length - 1 : prev;
        return Math.max(0, cur - 1);
      });
    } else if (key === "return") {
      if (selectedEvent) void doRewind(selectedEvent.seq);
    } else if (key === "F") {
      if (selectedEvent) void doRewind(selectedEvent.seq);
    } else if (key === "W") {
      if (selectedEvent) void doRewind(selectedEvent.seq);
    } else if (key === "L") {
      setSelectedIdx(-1);
      setActionError(null);
    }
  });

  const liveColor = isLive ? "#00d787" : "#ffaf00";
  const liveLabel = isLive ? "[live]" : `[f${safeIdx + 1}]`;

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Status bar */}
      <box width="100%" height={1} flexDirection="row">
        <text fg="#555555">{"  TIMELINE "}</text>
        <text fg={liveColor}>{liveLabel}</text>
        <text fg="#555555">{`  ${events.length} frames`}</text>
        {streaming ? <text fg="#555555">{"  ●"}</text> : null}
        {busy ? <text fg="#ffaf00">{"  (working…)"}</text> : null}
        {actionError ? (
          <text fg="#ff5f5f">{`  ! ${actionError.slice(0, 40)}`}</text>
        ) : null}
      </box>

      {/* Tick strip */}
      <TickStrip
        events={events}
        selectedIdx={safeIdx}
        totalWidth={width}
        compact={compact}
      />

      {/* Divider */}
      <box width="100%" height={1}>
        <text fg="#333333">{"─".repeat(Math.min(width, 240))}</text>
      </box>

      {/* Node snapshot at selected frame */}
      <box width="100%" flexGrow={1}>
        {selectedEvent !== undefined ? (
          <SnapshotPanel events={events} upToSeq={selectedEvent.seq} />
        ) : (
          <scrollbox width="100%" height="100%" scrollY>
            <text fg="#444444">{"  (no events yet)"}</text>
          </scrollbox>
        )}
      </box>
    </box>
  );
}
