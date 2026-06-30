import { useRunEvents } from "../data.ts";

export function EventsMode({ runId }: { runId: string }) {
  const { events } = useRunEvents(runId, { maxEvents: 200 });
  return (
    <box width="100%" height="100%">
      <text>{`${events.length} event(s) total`}</text>
    </box>
  );
}
