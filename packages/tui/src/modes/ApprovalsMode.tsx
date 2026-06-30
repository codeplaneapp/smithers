import { useApprovals } from "../data.ts";

export function ApprovalsMode({ runId }: { runId: string }) {
  const { data, loading } = useApprovals(runId);
  return (
    <box width="100%" height="100%">
      <text>{loading ? "Loading approvals…" : `${(data ?? []).length} pending approval(s)`}</text>
    </box>
  );
}
