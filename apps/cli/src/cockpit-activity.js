/**
 * Selected-agent activity strip for the workflow supervisor.
 *
 * Builds a short sliding window (last N tool/actions) from durable run events
 * so the outline can show what the focused agent is doing without opening a
 * detail tab.
 */

import { parseAgentEvent } from "./chat.js";
import { sanitizeTerminalText } from "@smthrs/tui/src/sanitizeTerminalText.ts";

/** Fixed height of the activity body (excluding separator / label). */
export const ACTIVITY_STRIP_LINES = 4;

/**
 * The run-event types the activity strip renders. Both read paths window over
 * exactly these: the direct-db path pre-filters them in SQL (loadNodeActivity),
 * and the gateway path pre-filters them before pushing into its activity ring
 * (createGatewayObservationSource) — so a busy run's non-activity events never
 * dilute/evict the focused node's rows from the bounded ring.
 */
export const ACTIVITY_EVENT_TYPES = ["AgentEvent", "ToolCallStarted", "ToolCallFinished"];

/**
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   title: string,
 *   status: "running" | "done" | "error" | "info",
 *   detail: string,
 *   seq: number,
 * }} ActivityLine
 */

/**
 * @param {unknown} value
 * @param {number} max
 */
function truncate(value, max) {
  const s = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {unknown} payloadJson
 */
function parsePayload(payloadJson) {
  if (typeof payloadJson !== "string" || payloadJson === "") return null;
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} input
 */
/**
 * @param {unknown} input
 * @param {number} [max]
 */
function summarizeInput(input, max = 48) {
  const cap = Math.max(16, Math.floor(max));
  if (input == null) return "";
  if (typeof input === "string") return truncate(input, cap);
  if (typeof input === "object") {
    const rec = /** @type {Record<string, unknown>} */ (input);
    const cmd = rec.command ?? rec.cmd ?? rec.path ?? rec.file ?? rec.query ?? rec.pattern;
    if (typeof cmd === "string" && cmd !== "") return truncate(cmd, cap);
    try {
      return truncate(JSON.stringify(input), cap);
    } catch {
      return "";
    }
  }
  return truncate(input, cap);
}

/**
 * Collapse ordered event rows into last-N activity lines for one node.
 *
 * @param {Array<{ type?: string, seq?: number, payloadJson?: string, timestampMs?: number }>} rows
 * @param {string} nodeId
 * @param {{ limit?: number, detailMax?: number }} [opts]
 * @returns {ActivityLine[]}
 */
export function buildActivityLinesFromEvents(rows, nodeId, opts = {}) {
  const limit = Math.max(1, Math.min(80, Math.floor(opts.limit ?? ACTIVITY_STRIP_LINES)));
  const detailMax = Math.max(16, Math.floor(opts.detailMax ?? 48));
  if (!nodeId || !Array.isArray(rows) || rows.length === 0) return [];

  /** @type {Map<string, ActivityLine>} */
  const byId = new Map();
  /** @type {string[]} */
  const order = [];

  /**
   * @param {ActivityLine} line
   */
  const upsert = (line) => {
    if (!byId.has(line.id)) order.push(line.id);
    byId.set(line.id, line);
  };

  for (const row of rows) {
    const seq = typeof row.seq === "number" ? row.seq : 0;
    const type = String(row.type ?? "");

    if (type === "AgentEvent") {
      const payload = parsePayload(row.payloadJson);
      const rowNode = payload && typeof payload.nodeId === "string" ? payload.nodeId : "";
      if (rowNode && rowNode !== nodeId) continue;

      const agentEvent =
        payload && typeof payload.event === "object" && payload.event
          ? /** @type {Record<string, unknown>} */ (payload.event)
          : null;
      if (!agentEvent) continue;

      // Real CLI agents: type "action" with kind tool/command/…
      if (agentEvent.type === "action") {
        const action =
          agentEvent.action && typeof agentEvent.action === "object"
            ? /** @type {Record<string, unknown>} */ (agentEvent.action)
            : {};
        const kind = String(action.kind ?? "action");
        if (
          kind !== "tool" &&
          kind !== "command" &&
          kind !== "file_change" &&
          kind !== "web_search" &&
          kind !== "reasoning"
        ) {
          // Still accept via parseAgentEvent for thought/note edge cases we care about
          const parsed = parseAgentEvent({
            type: "AgentEvent",
            payloadJson: row.payloadJson ?? "",
            seq,
            timestampMs: typeof row.timestampMs === "number" ? row.timestampMs : 0,
          });
          if (!parsed) continue;
          const id = String(action.id ?? `agent-${seq}`);
          const title = String(action.title ?? kind);
          const phase = String(agentEvent.phase ?? "");
          const ok = agentEvent.ok !== false;
          upsert({
            id,
            kind,
            title,
            status: phase === "started" ? "running" : phase === "completed" ? (ok ? "done" : "error") : "info",
            detail:
              summarizeInput(action.detail, detailMax) ||
              truncate(parsed.text.replace(/^\[[^\]]+\]\s*/, ""), detailMax),
            seq,
          });
          continue;
        }

        const id = String(action.id ?? `${kind}-${seq}`);
        const title = String(action.title ?? kind);
        const phase = String(agentEvent.phase ?? "");
        const detailObj =
          action.detail && typeof action.detail === "object"
            ? /** @type {Record<string, unknown>} */ (action.detail)
            : {};
        const detail =
          summarizeInput(detailObj.input, detailMax) ||
          summarizeInput(detailObj.output, detailMax) ||
          truncate(agentEvent.message, detailMax);
        const ok = agentEvent.ok !== false;
        const prev = byId.get(id);
        if (phase === "started") {
          upsert({
            id,
            kind,
            title,
            status: "running",
            detail: detail || prev?.detail || "",
            seq,
          });
        } else if (phase === "completed") {
          upsert({
            id,
            kind,
            title,
            status: ok ? "done" : "error",
            detail: detail || prev?.detail || "",
            seq,
          });
        } else {
          upsert({
            id,
            kind,
            title,
            status: "info",
            detail: detail || prev?.detail || "",
            seq,
          });
        }
        continue;
      }

      // Scripted / fixture agents: tool_start / tool_end
      if (agentEvent.type === "tool_start") {
        const name = String(agentEvent.name ?? "tool");
        const id = `tool:${name}:${seq}`;
        upsert({
          id,
          kind: "tool",
          title: name,
          status: "running",
          detail: summarizeInput(agentEvent.input, detailMax),
          seq,
        });
        continue;
      }
      if (agentEvent.type === "tool_end") {
        const name = String(agentEvent.name ?? "tool");
        // Match latest open tool with same name
        let targetId = null;
        for (let i = order.length - 1; i >= 0; i--) {
          const cand = byId.get(order[i]);
          if (cand && cand.kind === "tool" && cand.title === name && cand.status === "running") {
            targetId = cand.id;
            break;
          }
        }
        const id = targetId ?? `tool:${name}:${seq}`;
        const prev = byId.get(id);
        upsert({
          id,
          kind: "tool",
          title: name,
          status: "done",
          detail: summarizeInput(agentEvent.output, detailMax) || prev?.detail || "",
          seq,
        });
        continue;
      }

      // progress messages as light activity
      if (agentEvent.type === "progress") {
        const msg = String(agentEvent.message ?? "").trim();
        if (!msg) continue;
        upsert({
          id: `progress-${seq}`,
          kind: "progress",
          title: "progress",
          status: "info",
          detail: truncate(msg, Math.max(detailMax, 56)),
          seq,
        });
      }
      continue;
    }

    if (type === "ToolCallStarted" || type === "ToolCallFinished") {
      const payload = parsePayload(row.payloadJson);
      if (!payload) continue;
      const rowNode = typeof payload.nodeId === "string" ? payload.nodeId : "";
      if (rowNode && rowNode !== nodeId) continue;
      const name = String(payload.toolName ?? payload.name ?? "tool");
      const id = String(payload.seq != null ? `tc-${payload.seq}` : `tc-${name}-${seq}`);
      const prev = byId.get(id);
      if (type === "ToolCallStarted") {
        upsert({
          id,
          kind: "tool",
          title: name,
          status: "running",
          detail: summarizeInput(payload.input, detailMax),
          seq,
        });
      } else {
        const st = String(payload.status ?? "ok");
        upsert({
          id,
          kind: "tool",
          title: name,
          status: st === "error" || st === "failed" ? "error" : "done",
          detail: summarizeInput(payload.output, detailMax) || prev?.detail || "",
          seq,
        });
      }
    }
  }

  const lines = order.map((id) => byId.get(id)).filter(Boolean);
  return lines.slice(-limit);
}

/**
 * Format one activity line for the strip (no ANSI — paint applies color).
 *
 * @param {ActivityLine} line
 */
export function formatActivityPlain(line) {
  const glyph = line.status === "running" ? "▸" : line.status === "done" ? "✓" : line.status === "error" ? "✗" : "·";
  const title = line.title || line.kind || "action";
  const detail = line.detail ? ` ${line.detail}` : "";
  return sanitizeTerminalText(`${glyph} ${title}${detail}`);
}

/**
 * Load last-N activity lines for a node from the store.
 *
 * Event history is ASC + limit, so we window near the run's latest seq to get
 * recent activity rather than the oldest page.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {{ limit?: number, detailMax?: number }} [opts]
 * @returns {Promise<ActivityLine[]>}
 */
export async function loadNodeActivity(adapter, runId, nodeId, opts = {}) {
  const limit = Math.max(1, Math.min(80, Math.floor(opts.limit ?? ACTIVITY_STRIP_LINES)));
  const detailMax = Math.max(16, Math.floor(opts.detailMax ?? 48));
  if (!adapter || !runId || !nodeId) return [];
  try {
    const lastSeqRaw = await adapter.getLastEventSeq(runId);
    const lastSeq = typeof lastSeqRaw === "number" && Number.isFinite(lastSeqRaw) ? lastSeqRaw : -1;
    const afterSeq = Math.max(-1, lastSeq - 500);
    const rows =
      (await adapter.listEventHistory(runId, {
        afterSeq,
        nodeId,
        types: ACTIVITY_EVENT_TYPES,
        limit: 500,
      })) ?? [];
    return buildActivityLinesFromEvents(rows, nodeId, { limit, detailMax });
  } catch {
    return [];
  }
}

/**
 * Fit a plain activity line to a terminal width (full-width detail panes).
 * @param {ActivityLine} line
 * @param {number} cols
 */
export function formatActivityPlainWidth(line, cols) {
  const max = Math.max(24, Math.floor(cols) - 2);
  const plain = formatActivityPlain(line);
  return truncate(plain, max);
}
