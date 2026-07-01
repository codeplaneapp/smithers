import type { GatewayEventFrame } from "../data.ts";
import { unwrapEvent } from "./eventFrame.ts";

export { unwrapEvent };

export type FrameMarker = "notable" | "gate" | "normal";

export type NodeSnapshot = {
  id: string;
  name?: string;
  status: string;
  /**
   * Loop/retry attempt this snapshot represents (from the event payload's
   * `iteration`/`attempt`). Absent for container nodes with no attempt identity.
   * Snapshots are keyed by id + iteration so two attempts of one logical node
   * don't collapse into a single row.
   */
  iteration?: number;
};

function iterationOf(payload: Record<string, unknown>): number | undefined {
  const v = payload["iteration"] ?? payload["attempt"];
  return typeof v === "number" ? v : undefined;
}

/** Stable map key disambiguating attempts of one logical node id. */
export function snapshotKey(id: string, iteration: number | undefined): string {
  return JSON.stringify([id, iteration ?? 0]);
}

export function classifyFrame(ev: GatewayEventFrame): FrameMarker {
  const event = unwrapEvent(ev).name.toLowerCase();
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
    const { name: rawEventName, payload: p } = unwrapEvent(ev);
    if (!p) continue;
    const rawId = p["nodeId"] ?? p["node_id"];
    const nodeId = typeof rawId === "string" ? rawId : undefined;
    if (!nodeId) continue;

    const rawName = p["name"] ?? p["nodeName"] ?? p["node_name"];
    const name = typeof rawName === "string" ? rawName : undefined;
    const iteration = iterationOf(p);
    const rawStatus = p["status"] ?? p["state"];
    const statusFromPayload = typeof rawStatus === "string" ? rawStatus : undefined;
    const eventName = rawEventName.toLowerCase();

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
    } else if (eventName.includes("node.cancel")) {
      inferredStatus = "cancelled";
    } else if (eventName.includes("node.fail") || eventName.includes("node.error")) {
      inferredStatus = "failed";
    } else if (eventName.includes("approval") && eventName.includes("request")) {
      inferredStatus = "waiting";
    }

    // Key by node id + iteration so loop/retry attempts of one logical node stay
    // as distinct rows instead of the later attempt overwriting the earlier.
    const key = snapshotKey(nodeId, iteration);
    if (!nodeMap.has(key)) {
      nodeMap.set(key, { id: nodeId, name, status: inferredStatus ?? "running", iteration });
    } else if (inferredStatus !== undefined || name !== undefined) {
      const existing = nodeMap.get(key)!;
      nodeMap.set(key, {
        id: nodeId,
        name: name ?? existing.name,
        status: inferredStatus ?? existing.status,
        iteration: existing.iteration ?? iteration,
      });
    }
  }

  return Array.from(nodeMap.values());
}

export function nodeStatusGlyph(status: string): string {
  if (status === "done") return "✓";
  if (status === "running") return "●";
  if (status === "waiting") return "⏸";
  // A user-cancelled node is terminal but NOT a failure: distinct dim ⊘, not the
  // red ✗, mirroring the tree/header cancelled glyph.
  if (status === "cancelled" || status === "canceled") return "⊘";
  if (status === "failed") return "✗";
  return "○";
}

export function nodeStatusColor(status: string): string {
  if (status === "done") return "#00d787";
  if (status === "running") return "#00d7ff";
  if (status === "waiting") return "#ffaf00";
  // Cancelled: dim grey (terminal but not a failure), never the red failure
  // color, mirroring the header/tree cancelled dot.
  if (status === "cancelled" || status === "canceled") return "#888888";
  if (status === "failed") return "#ff5f5f";
  return "#555555";
}
