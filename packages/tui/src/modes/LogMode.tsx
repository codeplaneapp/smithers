import { useState, useMemo, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunEvents, TUI_EVENT_CAP } from "../data.ts";
import type { GatewayEventFrame } from "../data.ts";
import {
  extractEventText,
  extractAttemptKeys,
  filterEventsByAttempt,
  splitAttemptKey,
} from "./logUtils.ts";
import { normalizeFrame } from "./eventFrame.ts";

const COMPACT_WIDTH = 100;

/**
 * Thin wrapper: reads the gateway event stream and hands the data to the pure
 * presentational `LogView`. Keeping the only gateway hook here means render
 * tests can exercise the REAL view with injected events (no gateway/provider),
 * so the tests can't pass against a divergent clone of this UI.
 */
export function LogMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunEvents(runId, { maxEvents: TUI_EVENT_CAP });
  return <LogView events={events} streaming={streaming} />;
}

/**
 * Presentational LOGS view. Takes its events as a prop (no gateway hooks) and
 * owns only local UI state: the follow toggle and the per-attempt filter. This
 * is the exact component the render tests mount with canned data.
 */
export function LogView({
  events,
  streaming = false,
}: {
  events: GatewayEventFrame[];
  streaming?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const [follow, setFollow] = useState(true);
  const [attemptIdx, setAttemptIdx] = useState(-1); // -1 = all attempts

  const attempts = useMemo(() => extractAttemptKeys(events), [events]);

  // Keep the selection in range as attempts appear/disappear: snap back to -1
  // ("all") when there are no attempts, and clamp to the last attempt when the
  // list shrinks. Without this, a `]` press while empty would pin attemptIdx to
  // 0 and silently filter every later event to the first attempt.
  useEffect(() => {
    setAttemptIdx((prev) => {
      if (attempts.length === 0) return -1;
      if (prev > attempts.length - 1) return attempts.length - 1;
      return prev;
    });
  }, [attempts.length]);

  const filteredEvents = useMemo(() => {
    if (attemptIdx < 0 || attempts.length === 0) return events;
    const key = attempts[attemptIdx];
    if (!key) return events;
    return filterEventsByAttempt(events, key);
  }, [events, attempts, attemptIdx]);

  useKeyboard((e) => {
    if (e.name === "f") {
      setFollow((prev) => !prev);
    } else if (e.name === "[") {
      setAttemptIdx((prev) => Math.max(-1, prev - 1));
    } else if (e.name === "]") {
      // No attempts → stay at -1 ("all"); never jump to a phantom attempt 0.
      setAttemptIdx((prev) =>
        attempts.length === 0 ? -1 : Math.min(attempts.length - 1, prev + 1),
      );
    }
  });

  const tagMaxLen = compact ? 6 : 12;

  const attemptLabel = (() => {
    if (attemptIdx < 0 || attempts.length === 0) return null;
    const key = attempts[attemptIdx];
    if (!key) return null;
    // Split on the LAST colon so namespaced node ids (which contain colons)
    // aren't truncated to their first segment.
    const { nodeId, iteration } = splitAttemptKey(key);
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
        {attemptLabel ? (
          <text fg="#888888">{`  attempt:${attemptLabel}`}</text>
        ) : null}
      </box>
      <scrollbox
        width="100%"
        flexGrow={1}
        scrollY
        stickyScroll={follow}
        stickyStart="bottom"
      >
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
                <text fg="#cccccc" wrapMode="char">{text}</text>
              </box>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}
