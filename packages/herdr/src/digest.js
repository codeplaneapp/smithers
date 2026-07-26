/**
 * Deterministic overview digest + fleet strip helpers (no LLM).
 * Pure string builders for the overview board / multi-run header.
 */

/**
 * @typedef {{
 *   runId: string;
 *   status?: string;
 *   label?: string;
 *   blocked?: number;
 *   working?: number;
 * }} FleetRunRow
 */

/**
 * @typedef {{
 *   runId: string;
 *   status?: string;
 *   elapsedMs?: number;
 *   working?: number;
 *   blocked?: number;
 *   failed?: number;
 *   done?: number;
 *   activeNodeIds?: string[];
 *   attentionLines?: string[];
 *   queuedSteerCount?: number;
 *   lastEventSummary?: string;
 *   nowMs?: number;
 * }} DigestInput
 */

/**
 * Format a short elapsed duration.
 *
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "?";
  }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) {
    return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
  }
  const hr = Math.floor(min / 60);
  const m2 = min % 60;
  return m2 === 0 ? `${hr}h` : `${hr}h ${m2}m`;
}

/**
 * Local clock label HH:MM for digest headers (deterministic when nowMs fixed).
 *
 * @param {number} nowMs
 * @returns {string}
 */
export function formatClockHm(nowMs) {
  const d = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Build a multi-run fleet strip (one line). Focused run is marked with `●`.
 * Empty / single-run inputs return "" (no strip).
 *
 * @param {FleetRunRow[]} runs
 * @param {string | undefined} focusedRunId
 * @returns {string}
 */
export function buildFleetStrip(runs, focusedRunId) {
  if (!Array.isArray(runs) || runs.length < 2) {
    return "";
  }
  const parts = runs.map((r) => {
    const id = r.runId ?? "?";
    const short = id.length > 16 ? `${id.slice(0, 14)}…` : id;
    const label = typeof r.label === "string" && r.label !== "" ? r.label : short;
    const status = r.status ?? "unknown";
    const mark = id === focusedRunId ? "●" : " ";
    const attention = typeof r.blocked === "number" && r.blocked > 0 ? ` !${r.blocked}` : "";
    return `${mark}${label} ${status}${attention}`;
  });
  return `fleet: ${parts.join(" | ")}`;
}

/**
 * Build a deterministic digest block (always ends with newline when non-empty).
 *
 * @param {DigestInput} input
 * @returns {string}
 */
export function buildDigestBlock(input) {
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const clock = formatClockHm(nowMs);
  const elapsed = formatElapsed(input.elapsedMs);
  const w = input.working ?? 0;
  const b = input.blocked ?? 0;
  const f = input.failed ?? 0;
  const d = input.done ?? 0;
  const lines = [
    `── digest ${clock} ──`,
    `run ${input.runId} · ${input.status ?? "unknown"} · elapsed ${elapsed}`,
    `${w} working / ${b} blocked / ${f} failed / ${d} done`,
  ];
  const active = Array.isArray(input.activeNodeIds) ? input.activeNodeIds.filter(Boolean) : [];
  if (active.length > 0) {
    lines.push(`active: ${active.slice(0, 8).join(", ")}${active.length > 8 ? "…" : ""}`);
  }
  const attention = Array.isArray(input.attentionLines) ? input.attentionLines.filter(Boolean) : [];
  if (attention.length > 0) {
    lines.push(`attention: ${attention.slice(0, 4).join(" · ")}`);
  }
  if (typeof input.queuedSteerCount === "number" && input.queuedSteerCount > 0) {
    lines.push(`steers: ${input.queuedSteerCount} queued`);
  }
  if (typeof input.lastEventSummary === "string" && input.lastEventSummary !== "") {
    lines.push(`last: ${input.lastEventSummary}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Stable signature for digest dedupe (ignore pure clock if counts/nodes equal —
 * callers that want a heartbeat every interval should compare including clock or
 * force-emit on timer). This signature omits clock so identical state collapses.
 *
 * @param {DigestInput} input
 * @returns {string}
 */
export function digestSignature(input) {
  const active = (input.activeNodeIds ?? []).slice().sort().join(",");
  const attention = (input.attentionLines ?? []).slice().sort().join("|");
  return [
    input.runId,
    input.status ?? "",
    input.working ?? 0,
    input.blocked ?? 0,
    input.failed ?? 0,
    input.done ?? 0,
    input.queuedSteerCount ?? 0,
    active,
    attention,
    input.lastEventSummary ?? "",
    // bucket elapsed to 30s so sub-interval drift doesn't force rewrite
    Math.floor((input.elapsedMs ?? 0) / 30_000),
  ].join("\u0001");
}

/** Default digest poll interval (product freeze). */
export const DEFAULT_DIGEST_INTERVAL_MS = 30_000;
