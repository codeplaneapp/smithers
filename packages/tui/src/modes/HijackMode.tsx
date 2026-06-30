import { useRunTree } from "../data.ts";

export function HijackMode({ runId }: { runId: string }) {
  const { nodes } = useRunTree(runId);
  const running = nodes.filter((n) => n.status === "running" || n.status === "active");
  return (
    <box width="100%" height="100%">
      <text fg="#555555">
        {running.length > 0
          ? `  HIJACK — select a running node (${running.length} running)  [h] hijack  [Esc] cancel`
          : "  HIJACK — no running nodes to hijack"}
      </text>
    </box>
  );
}
