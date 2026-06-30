import { useRunEvents } from "../data.ts";

export function LogMode({ runId }: { runId: string }) {
  const { events, streaming } = useRunEvents(runId);
  return (
    <box width="100%" height="100%">
      <text>{streaming ? `${events.length} event(s) — streaming` : `${events.length} event(s)`}</text>
    </box>
  );
}
