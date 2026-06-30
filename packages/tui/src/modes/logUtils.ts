import type { GatewayEventFrame } from "../data.ts";
import { normalizeFrame } from "./eventFrame.ts";

export type AttemptKey = string; // `${nodeId}:${iteration}`

export function extractNodeId(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p) return null;
  const v = p["nodeId"] ?? p["node_id"] ?? p["nodeid"];
  return typeof v === "string" ? v : null;
}

export function extractIteration(payload: unknown): number | null {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p) return null;
  const v = p["iteration"] ?? p["attempt"];
  return typeof v === "number" ? v : null;
}

export function extractEventText(event: string, payload: unknown): string {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p) return event;

  if (typeof p["text"] === "string") return p["text"].slice(0, 200);
  if (typeof p["content"] === "string") return p["content"].slice(0, 200);
  if (typeof p["message"] === "string") return p["message"].slice(0, 200);

  const toolName = String(p["name"] ?? p["tool"] ?? p["toolName"] ?? p["tool_name"] ?? "");
  if (toolName) return `${toolName}(…)`;

  const str = JSON.stringify(p);
  return str.length > 120 ? str.slice(0, 117) + "…" : str;
}

export function makeAttemptKey(nodeId: string, iteration: number | null): AttemptKey {
  return `${nodeId}:${iteration ?? 0}`;
}

/** Extract unique attempt keys (nodeId:iteration) in order of first appearance. */
export function extractAttemptKeys(events: GatewayEventFrame[]): AttemptKey[] {
  const seen: AttemptKey[] = [];
  const seenSet = new Set<string>();
  for (const e of events) {
    const { payload, nodeId } = normalizeFrame(e);
    if (!nodeId) continue;
    const iter = extractIteration(payload);
    const k = makeAttemptKey(nodeId, iter);
    if (!seenSet.has(k)) {
      seenSet.add(k);
      seen.push(k);
    }
  }
  return seen;
}

/**
 * Split an AttemptKey back into its nodeId + iteration. The key is
 * `${nodeId}:${iteration}` and the iteration is always numeric, so split on the
 * LAST colon — node ids are commonly namespaced (e.g. `mode:tree:1`) and contain
 * colons, which an `indexOf` split would truncate.
 */
export function splitAttemptKey(key: AttemptKey): { nodeId: string; iteration: number } {
  const colonIdx = key.lastIndexOf(":");
  const nodeId = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
  const iterStr = colonIdx >= 0 ? key.slice(colonIdx + 1) : "0";
  const parsed = parseInt(iterStr, 10);
  return { nodeId, iteration: Number.isNaN(parsed) ? 0 : parsed };
}

/** Filter events to a single attempt identified by its AttemptKey. */
export function filterEventsByAttempt(
  events: GatewayEventFrame[],
  key: AttemptKey,
): GatewayEventFrame[] {
  const { nodeId, iteration } = splitAttemptKey(key);

  return events.filter((e) => {
    const norm = normalizeFrame(e);
    if (norm.nodeId !== nodeId) return false;
    const eIter = extractIteration(norm.payload) ?? 0;
    return eIter === iteration;
  });
}
