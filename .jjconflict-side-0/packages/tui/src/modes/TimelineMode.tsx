import { useState, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunEvents, TUI_EVENT_CAP } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import {
  classifyFrame,
  frameTickChar,
  frameTickColor,
  extractNodeSnapshots,
  nodeStatusGlyph,
  nodeStatusColor,
  snapshotKey,
} from "./timelineUtils.ts";
import { unwrapEvent } from "./eventFrame.ts";
import { isModifiedKeyEvent } from "./treeUtils.ts";
import { useOverlayOpen } from "../OverlayContext.tsx";

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
    ? "[j/k]scrub [L]live"
    : "[j/k] scrub events  [L] back to live";

  return (
    <box width="100%" height={3} flexDirection="column">
      {/* Info row: position + selected event name. Unwrap the gateway's
          `run.event` envelope — every live-streamed frame's outer `event` is the
          literal string "run.event"; the engine event name lives inside. */}
      <box width="100%" height={1} flexDirection="row">
        <text fg="#444444">{`  frame ${selectedIdx + 1}/${events.length}`}</text>
        {selEvent ? (
          <text fg="#555555">{`  seq:${selEvent.seq}  ${unwrapEvent(selEvent).name}`}</text>
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
    [events, upToSeq],
  );

  return (
    <scrollbox width="100%" height="100%" scrollY>
      {snapshots.length === 0 ? (
        <text fg="#444444">{"  (no node activity at this frame)"}</text>
      ) : (
        snapshots.map((node) => (
          <box key={snapshotKey(node.id, node.iteration)} width="100%" height={1} flexDirection="row">
            <text fg={nodeStatusColor(node.status)}>{`  ${nodeStatusGlyph(node.status)} `}</text>
            <text fg="#cccccc">{node.name ?? node.id}</text>
            {node.iteration !== undefined ? <text fg="#666666">{`  #${node.iteration}`}</text> : null}
            <text fg="#555555">{`  [${node.status}]`}</text>
          </box>
        ))
      )}
    </scrollbox>
  );
}

// ─── Main TimelineMode ────────────────────────────────────────────────────────

/**
 * Thin wrapper: reads the gateway event stream and hands it to the pure
 * presentational `TimelineView`. Keeping the gateway hook here lets render tests
 * mount the REAL view with injected events (no gateway/provider), so the tests
 * can't drift from production.
 */
export function TimelineMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunEvents(runId, { maxEvents: TUI_EVENT_CAP });
  return <TimelineView events={events} streaming={streaming} />;
}

/**
 * Presentational TIMELINE view. Takes its events as a prop (no gateway hooks)
 * and owns only the local scrub position. This is the exact component the render
 * tests mount with canned data.
 *
 * Scope note: this is an EVENT timeline you can scrub to inspect node state at
 * any point in run history — it deliberately offers NO rewind. Frame rewind
 * needs a real `_smithers_frames.frame_no`, and the live run-event stream the
 * monitor subscribes to (`useGatewayRunEvents`) does not carry frame numbers
 * (only `_smithers_frames` / the DevTools snapshot stream do). Advertising a "W
 * rewind" here would either no-op or, worse, rewind to a guessed frame — so we
 * surface the honest inspect-only affordance and point at the `smithers rewind`
 * CLI for the destructive frame operation instead.
 */
export function TimelineView({
  events,
  streaming = false,
}: {
  events: GatewayEventFrame[];
  streaming?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const overlayOpen = useOverlayOpen();

  // selectedIdx = -1 means "live" (show latest frame)
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const safeIdx =
    events.length === 0
      ? 0
      : selectedIdx < 0
        ? events.length - 1
        : Math.min(selectedIdx, events.length - 1);

  const isLive = selectedIdx < 0;
  const selectedEvent = events[safeIdx];

  useKeyboard((e) => {
    // Keys must not leak through an open help overlay, and ctrl/meta chords
    // (Ctrl-K etc.) are not scrub bindings.
    if (overlayOpen || isModifiedKeyEvent(e)) return;
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
    } else if (key === "l" && e.shift) {
      // Shift+L = back to live. parseKeypress lowercases shifted letters
      // (raw "L" and kitty CSI both arrive as { name: "l", shift: true }), so
      // matching the literal name "L" would be dead code — and App.tsx's bare
      // `l` Logs alias is shift-guarded so this binding can be reached at all.
      setSelectedIdx(-1);
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
        <text fg="#444444">{"  inspect-only · rewind via `smithers rewind`"}</text>
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
