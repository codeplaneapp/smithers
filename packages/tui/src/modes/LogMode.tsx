import { useState, useMemo, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunInspectorVm } from "@smithers-orchestrator/ui-core";
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

const COMPACT_WIDTH = 100;

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
  return <LogView events={events} streaming={streaming} />;
}

/**
 * Presentational LOGS view. Takes its events as a prop (no gateway hooks) and
 * owns only local UI state: the follow toggle and the per-attempt filter. This
 * is the exact component the render tests mount with canned data.
 */
export function LogView({ events, streaming = false }: { events: GatewayEventFrame[]; streaming?: boolean }) {
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const overlayOpen = useOverlayOpen();
  const [follow, setFollow] = useState(true);
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
    return `${nodeId.slice(0, tagMaxLen)}:${iteration}`;
  })();

  const followColor = follow ? "#00d787" : "#ffaf00";

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
          filteredEvents.map((ev) => {
            const { event, payload, nodeId } = normalizeFrame(ev);
            const text = extractEventText(event, payload);
            const tag = nodeId ? nodeId.slice(0, tagMaxLen) : "·";
            const seqStr = String(ev.seq).padStart(4, " ");

            return (
              <box key={ev.seq} width="100%" height={1} flexDirection="row">
                <text fg="#444444">{`${seqStr} `}</text>
                <text fg="#555555">{`[${tag}]`}</text>
                <text fg="#444444">{" │ "}</text>
                <text fg="#cccccc" wrapMode="char">
                  {text}
                </text>
              </box>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}
