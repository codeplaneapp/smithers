import { useState, useMemo, useEffect, useRef } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunInspectorVm } from "@smthrs/ui-core";
import { TUI_EVENT_CAP } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import {
  extractEventText,
  extractAttemptKeys,
  filterEventsByAttempt,
  splitAttemptKey,
  type AttemptKey,
} from "./logUtils.ts";
import { normalizeFrame } from "./eventFrame.ts";
import { isModifiedKeyEvent } from "./treeUtils.ts";
import { useOverlayOpen } from "../OverlayContext.tsx";
import { sanitizeTerminalText } from "@smthrs/tui-ui";

const COMPACT_WIDTH = 100;
const LOG_WINDOW_VIEWPORTS = 3;

/**
 * Thin wrapper: reads the run's event stream via ui-core's
 * `useRunInspectorVm` (research/tui-parity/03-tui-screens.md groups Logs
 * under the "Run inspector" surface it drives) and hands the data to the pure
 * presentational `LogView`. Keeping the only gateway-backed hook here means
 * render tests can exercise the REAL view with injected events (no
 * gateway/provider), so the tests can't pass against a divergent clone of
 * this UI.
 */
export function LogMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunInspectorVm(runId, { maxEvents: TUI_EVENT_CAP });
  return <LogView key={runId} events={events} streaming={streaming} />;
}

/**
 * Presentational LOGS view. Takes its events as a prop (no gateway hooks) and
 * owns only local UI state: the follow toggle and the per-attempt filter. This
 * is the exact component the render tests mount with canned data.
 */
export function LogView({ events, streaming = false }: { events: GatewayEventFrame[]; streaming?: boolean }) {
  const { width, height } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const overlayOpen = useOverlayOpen();
  const [follow, setFollow] = useState(true);
  const pausedEndSeq = useRef<number | null>(null);
  const textBySeq = useRef(new Map<number, string>());
  // The filter is pinned to the attempt's KEY (nodeId:iteration), not a
  // positional index. `attempts` is rebuilt from the sliding event window, so
  // once the oldest attempt's frames evict from the front of the ring every
  // later index shifts left by one — a stored index would silently resolve to
  // a different attempt. null = "all attempts".
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptKey | null>(null);

  const attempts = useMemo(() => extractAttemptKeys(events), [events]);

  // If the window empties out entirely, fall back to "all" rather than
  // pinning to a key that can never come back.
  useEffect(() => {
    if (attempts.length === 0) setSelectedAttempt(null);
  }, [attempts.length]);

  const filteredEvents = useMemo(() => {
    if (selectedAttempt === null) return events;
    return filterEventsByAttempt(events, selectedAttempt);
  }, [events, selectedAttempt]);

  useKeyboard((e) => {
    // Keys must not leak through an open help overlay, and ctrl/meta chords
    // are not log-view bindings.
    if (overlayOpen || isModifiedKeyEvent(e)) return;
    if (e.name === "f") {
      if (follow) pausedEndSeq.current = filteredEvents.at(-1)?.seq ?? null;
      setFollow((prev) => !prev);
    } else if (e.name === "[") {
      setSelectedAttempt((prev) => {
        if (prev === null) return null;
        const idx = attempts.indexOf(prev);
        // idx < 0 means the selected attempt's own frames evicted from the
        // window; treat "previous" from an unknown position as "all".
        if (idx <= 0) return null;
        return attempts[idx - 1] ?? null;
      });
    } else if (e.name === "]") {
      setSelectedAttempt((prev) => {
        // No attempts → stay at "all"; never jump to a phantom attempt.
        if (attempts.length === 0) return null;
        if (prev === null) return attempts[0] ?? null;
        const idx = attempts.indexOf(prev);
        // idx < 0 means the selected attempt's own frames evicted from the
        // window; snap forward to the earliest attempt still present.
        if (idx < 0) return attempts[0] ?? null;
        if (idx >= attempts.length - 1) return prev;
        return attempts[idx + 1] ?? prev;
      });
    }
  });

  const tagMaxLen = compact ? 6 : 12;

  const attemptLabel = (() => {
    if (selectedAttempt === null) return null;
    // Split on the LAST colon so namespaced node ids (which contain colons)
    // aren't truncated to their first segment.
    const { nodeId, iteration } = splitAttemptKey(selectedAttempt);
    return `${sanitizeTerminalText(nodeId).slice(0, tagMaxLen)}:${iteration}`;
  })();

  const followColor = follow ? "#00d787" : "#ffaf00";
  const renderedRows = useMemo(() => {
    const windowRows = Math.max(1, height - 1) * LOG_WINDOW_VIEWPORTS;
    let end = filteredEvents.length;

    // When follow is paused, keep the rendered window anchored to the last
    // event that was visible instead of shifting it as streamed frames arrive.
    if (!follow && pausedEndSeq.current !== null) {
      let low = 0;
      let high = filteredEvents.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (filteredEvents[mid]!.seq <= pausedEndSeq.current) low = mid + 1;
        else high = mid;
      }
      end = low === 0 && filteredEvents.length > 0 ? 1 : low;
    }

    const visibleEvents = filteredEvents.slice(Math.max(0, end - windowRows), end);
    const rows = visibleEvents.map((ev) => {
      const { event, payload, nodeId } = normalizeFrame(ev);
      let text = textBySeq.current.get(ev.seq);
      if (text === undefined) {
        text = sanitizeTerminalText(extractEventText(event, payload));
        textBySeq.current.set(ev.seq, text);
      }

      return {
        seq: ev.seq,
        seqStr: String(ev.seq).padStart(4, " "),
        tag: nodeId ? sanitizeTerminalText(nodeId).slice(0, tagMaxLen) : "·",
        text,
      };
    });

    // The event ring itself is bounded; keep the memo bounded too.
    while (textBySeq.current.size > TUI_EVENT_CAP) {
      const oldestSeq = textBySeq.current.keys().next().value;
      if (oldestSeq === undefined) break;
      textBySeq.current.delete(oldestSeq);
    }

    return rows;
  }, [filteredEvents, follow, height, tagMaxLen]);

  return (
    <box width="100%" height="100%" flexDirection="column">
      <box width="100%" height={1} flexDirection="row">
        <text fg="#555555">{"  LOGS "}</text>
        <text fg={followColor}>{follow ? "[live]" : "[paused]"}</text>
        <text fg="#555555">{`  ${filteredEvents.length}/${events.length} events`}</text>
        {streaming ? <text fg="#555555">{"  ●"}</text> : null}
        <text fg="#555555">{compact ? "  [f][[][]]" : "  [f] follow  [[] prev  []] next"}</text>
        {attemptLabel ? <text fg="#888888">{`  attempt:${attemptLabel}`}</text> : null}
      </box>
      <scrollbox width="100%" flexGrow={1} scrollY stickyScroll={follow} stickyStart="bottom">
        {filteredEvents.length === 0 ? (
          <text fg="#444444">{"  (no events)"}</text>
        ) : (
          renderedRows.map((row) => (
            <box key={row.seq} width="100%" height={1} flexDirection="row">
              <text fg="#444444">{`${row.seqStr} `}</text>
              <text fg="#555555">{`[${row.tag}]`}</text>
              <text fg="#444444">{" │ "}</text>
              <text fg="#cccccc" wrapMode="char">
                {row.text}
              </text>
            </box>
          ))
        )}
      </scrollbox>
    </box>
  );
}
