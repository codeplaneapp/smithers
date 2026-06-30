import type { GatewayEventFrame } from "../data.ts";
import { normalizeFrame } from "./eventFrame.ts";

export type SideEffect = "read" | "write" | "shell" | null;

export type AttemptKey = string; // `${nodeId}:${iteration}`

/** Classify a tool-call event for the read/write/shell badge. Returns null for non-tool events. */
export function classifyToolSideEffect(event: string, payload: unknown): SideEffect {
  if (!event.toLowerCase().includes("tool")) return null;

  const p = (payload as Record<string, unknown> | null | undefined) ?? {};

  const sideEffect = String(p["sideEffect"] ?? p["side_effect"] ?? p["effect"] ?? "").toLowerCase();
  if (sideEffect) {
    if (/shell|bash|execute|command|run/.test(sideEffect)) return "shell";
    if (/write|edit|create|delete|move|filesystem/.test(sideEffect)) return "write";
    if (/read|view|list|search/.test(sideEffect)) return "read";
  }

  const toolName = String(
    p["name"] ?? p["tool"] ?? p["toolName"] ?? p["tool_name"] ?? "",
  ).toLowerCase();
  if (toolName) {
    if (/bash|shell|execute|run_command/.test(toolName)) return "shell";
    if (/write|edit|create|str_replace|insert|delete|move/.test(toolName)) return "write";
    if (/read|view|ls\b|list|search|find|grep|cat/.test(toolName)) return "read";
  }

  return null;
}

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

/** Filter events to a single attempt identified by its AttemptKey. */
export function filterEventsByAttempt(
  events: GatewayEventFrame[],
  key: AttemptKey,
): GatewayEventFrame[] {
  const colonIdx = key.indexOf(":");
  const nodeId = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
  const iterStr = colonIdx >= 0 ? key.slice(colonIdx + 1) : "0";
  const iteration = parseInt(iterStr, 10);

  return events.filter((e) => {
    const norm = normalizeFrame(e);
    if (norm.nodeId !== nodeId) return false;
    const eIter = extractIteration(norm.payload) ?? 0;
    return eIter === iteration;
  });
}

export function badgeLabel(effect: SideEffect): string {
  if (effect === "read") return "[read]";
  if (effect === "write") return "[write]";
  if (effect === "shell") return "[shell]";
  return "";
}

export function badgeColor(effect: SideEffect): string {
  if (effect === "read") return "#555555";
  if (effect === "write") return "#ffaf00";
  if (effect === "shell") return "#ff5f5f";
  return "#888888";
}
