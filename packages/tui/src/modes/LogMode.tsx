import { useState, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRunEvents } from "../data.ts";
import {
  classifyToolSideEffect,
  extractNodeId,
  extractEventText,
  extractAttemptKeys,
  filterEventsByAttempt,
  badgeLabel,
  badgeColor,
} from "./logUtils.ts";

const COMPACT_WIDTH = 100;

export function LogMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunEvents(runId, { maxEvents: 2000 });
  const { width } = useTerminalDimensions();
  const compact = width < COMPACT_WIDTH;
  const [follow, setFollow] = useState(true);
  const [attemptIdx, setAttemptIdx] = useState(-1); // -1 = all attempts

  const attempts = useMemo(() => extractAttemptKeys(events), [events]);

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
      setAttemptIdx((prev) => Math.min(Math.max(0, attempts.length - 1), prev + 1));
    }
  });

  const tagMaxLen = compact ? 6 : 12;

  const attemptLabel = (() => {
    if (attemptIdx < 0 || attempts.length === 0) return null;
    const key = attempts[attemptIdx];
    if (!key) return null;
    const idx = key.indexOf(":");
    const nodeId = idx >= 0 ? key.slice(0, idx) : key;
    const iter = idx >= 0 ? key.slice(idx + 1) : "0";
    return `${nodeId.slice(0, tagMaxLen)}:${iter}`;
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
            const nodeId = extractNodeId(ev.payload);
            const effect = classifyToolSideEffect(ev.event, ev.payload);
            const text = extractEventText(ev.event, ev.payload);
            const tag = nodeId ? nodeId.slice(0, tagMaxLen) : "·";
            const seqStr = String(ev.seq).padStart(4, " ");
            const badge = badgeLabel(effect);
            const bColor = badgeColor(effect);

            return (
              <box key={ev.seq} width="100%" height={1} flexDirection="row">
                <text fg="#444444">{`${seqStr} `}</text>
                <text fg="#555555">{`[${tag}]`}</text>
                <text fg="#444444">{" │ "}</text>
                {badge ? (
                  <text fg={bColor}>{`${badge} `}</text>
                ) : null}
                <text fg="#cccccc" wrapMode="char">{text}</text>
              </box>
            );
          })
        )}
      </scrollbox>
    </box>
  );
}
