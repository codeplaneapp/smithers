import { useRunEvents } from "../data.ts";

export function TimelineMode({ runId }: { runId: string }) {
  const { events } = useRunEvents(runId, { maxEvents: 2000 });
  return (
    <box width="100%" height="100%">
      <text fg="#555555">
        {`  TIMELINE — ${events.length} event(s)  [L] back to live  [⏎] jump to frame  [F] fork`}
      </text>
    </box>
  );
}
