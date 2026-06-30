import { useRun } from "../data.ts";

export function OutputMode({ runId }: { runId: string }) {
  const { data, loading } = useRun(runId);
  return (
    <box width="100%" height="100%">
      <text>{loading ? "Loading output…" : `Run state: ${data?.status ?? "unknown"}`}</text>
    </box>
  );
}
