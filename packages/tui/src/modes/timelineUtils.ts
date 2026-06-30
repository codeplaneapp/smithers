import type { GatewayEventFrame } from "../data.ts";

export type FrameMarker = "notable" | "gate" | "normal";

export type NodeSnapshot = {
  id: string;
  name?: string;
  status: string;
};

export function classifyFrame(ev: GatewayEventFrame): FrameMarker {
  const event = ev.event.toLowerCase();
  if (event.includes("approval") || event.includes("gate") || event.includes("wait")) {
    return "gate";
  }
  if (
    event.includes("tool") ||
    event.includes("agent.start") ||
    event.includes("node.start") ||
    event.includes("node.end") ||
    event.includes("run.start") ||
    event.includes("run.end") ||
    event.includes("heartbeat")
  ) {
    return "notable";
  }
  return "normal";
}

export function frameTickChar(marker: FrameMarker, isSelected: boolean): string {
  if (isSelected) return "█";
  if (marker === "gate") return "⊛";
  if (marker === "notable") return "│";
  return "·";
}

export function frameTickColor(marker: FrameMarker, isSelected: boolean): string {
  if (isSelected) return "#00d7ff";
  if (marker === "gate") return "#ffaf00";
  if (marker === "notable") return "#888888";
  return "#333333";
}

/** Reconstruct node statuses from events up to and including upToSeq. */
export function extractNodeSnapshots(
  events: GatewayEventFrame[],
  upToSeq: number,
): NodeSnapshot[] {
  const nodeMap = new Map<string, NodeSnapshot>();

  for (const ev of events) {
    if (ev.seq > upToSeq) break;
    const p = ev.payload as Record<string, unknown> | null | undefined;
    if (!p) continue;
    const rawId = p["nodeId"] ?? p["node_id"];
    const nodeId = typeof rawId === "string" ? rawId : undefined;
    if (!nodeId) continue;

    const rawName = p["name"] ?? p["nodeName"] ?? p["node_name"];
    const name = typeof rawName === "string" ? rawName : undefined;
    const rawStatus = p["status"] ?? p["state"];
    const statusFromPayload = typeof rawStatus === "string" ? rawStatus : undefined;
    const eventName = ev.event.toLowerCase();

    let inferredStatus: string | undefined;
    if (statusFromPayload) {
      inferredStatus = statusFromPayload;
    } else if (eventName.includes("node.start") || eventName.includes("node.begin")) {
      inferredStatus = "running";
    } else if (
      eventName.includes("node.end") ||
      eventName.includes("node.complete") ||
      eventName.includes("node.finish")
    ) {
      inferredStatus = "done";
    } else if (eventName.includes("node.fail") || eventName.includes("node.error")) {
      inferredStatus = "failed";
    } else if (eventName.includes("approval") && eventName.includes("request")) {
      inferredStatus = "waiting";
    }

    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, { id: nodeId, name, status: inferredStatus ?? "running" });
    } else if (inferredStatus !== undefined || name !== undefined) {
      const existing = nodeMap.get(nodeId)!;
      nodeMap.set(nodeId, {
        id: nodeId,
        name: name ?? existing.name,
        status: inferredStatus ?? existing.status,
      });
    }
  }

  return Array.from(nodeMap.values());
}

export function nodeStatusGlyph(status: string): string {
  if (status === "done") return "✓";
  if (status === "running") return "●";
  if (status === "waiting") return "⏸";
  if (status === "failed") return "✗";
  return "○";
}

export function nodeStatusColor(status: string): string {
  if (status === "done") return "#00d787";
  if (status === "running") return "#00d7ff";
  if (status === "waiting") return "#ffaf00";
  if (status === "failed") return "#ff5f5f";
  return "#555555";
}
