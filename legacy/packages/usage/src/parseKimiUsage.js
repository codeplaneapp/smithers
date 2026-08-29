/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Maps a Kimi rate-limit window's duration (in minutes) to a stable id/label,
 * matching the codex adapter's conventions: ~300 min is the 5-hour window,
 * day-scale is the weekly window.
 *
 * @param {number | undefined} minutes
 * @param {string} fallbackId
 * @returns {{ id: string; label: string }}
 */
function labelForMinutes(minutes, fallbackId) {
  if (minutes === undefined) return { id: fallbackId, label: fallbackId };
  if (minutes <= 60) return { id: "hourly", label: `${minutes}-minute` };
  if (minutes < 1440) return { id: "5h", label: `${Math.round(minutes / 60)}-hour` };
  if (minutes < 20160) return { id: "weekly", label: "weekly" };
  return { id: "monthly", label: "monthly" };
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toNumber(value) {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Converts a Kimi `{ duration, timeUnit }` window to minutes. The proto-enum
 * values observed are `TIME_UNIT_MINUTE`; unknown units fall back to seconds,
 * matching the kimi CLI's own labeling.
 *
 * @param {unknown} window
 * @returns {number | undefined}
 */
function windowMinutes(window) {
  if (!window || typeof window !== "object") return undefined;
  const w = /** @type {Record<string, unknown>} */ (window);
  const duration = toNumber(w.duration);
  if (duration === undefined) return undefined;
  const unit = typeof w.timeUnit === "string" ? w.timeUnit : "";
  if (unit.includes("MINUTE")) return duration;
  if (unit.includes("HOUR")) return duration * 60;
  if (unit.includes("DAY")) return duration * 1440;
  return duration / 60;
}

/**
 * Builds a percent window from a Kimi quota block
 * (`{ limit, used, remaining, resetTime }`, all string-valued). Kimi reports
 * utilization directly against the cap, so `used`/`limit` map to a percent.
 *
 * @param {unknown} block
 * @param {string} fallbackId
 * @param {number | undefined} minutes
 * @returns {UsageWindow | undefined}
 */
function percentWindowFrom(block, fallbackId, minutes) {
  if (!block || typeof block !== "object") return undefined;
  const b = /** @type {Record<string, unknown>} */ (block);
  const limit = toNumber(b.limit);
  let used = toNumber(b.used);
  if (used === undefined) {
    const remaining = toNumber(b.remaining);
    if (remaining !== undefined && limit !== undefined) used = limit - remaining;
  }
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  const { id, label } = labelForMinutes(minutes, fallbackId);
  const usedPercent = Math.min(Math.max((used / limit) * 100, 0), 100);
  let resetsAt;
  if (typeof b.resetTime === "string") {
    const ms = Date.parse(b.resetTime);
    if (Number.isFinite(ms)) resetsAt = new Date(ms).toISOString();
  }
  return { id, label, unit: "percent", usedPercent, resetsAt };
}

/**
 * Normalizes the Kimi for Coding usage payload (`GET /coding/v1/usages`) into
 * windows plus plan metadata. The top-level `usage` block is the weekly quota;
 * `limits[]` carries shorter rate windows (observed: a 300-minute window);
 * `parallel` is the concurrent-session cap, reported as a count window.
 *
 * @param {unknown} payload
 * @returns {{ windows: UsageWindow[]; planType?: string }}
 */
export function parseKimiUsage(payload) {
  if (!payload || typeof payload !== "object") return { windows: [] };
  const p = /** @type {Record<string, unknown>} */ (payload);
  const windows = [];

  const weekly = percentWindowFrom(p.usage, "weekly", 10080);
  if (weekly) windows.push(weekly);

  if (Array.isArray(p.limits)) {
    for (const item of p.limits) {
      if (!item || typeof item !== "object") continue;
      const it = /** @type {Record<string, unknown>} */ (item);
      const minutes = windowMinutes(it.window);
      const row = percentWindowFrom(
        it.detail ?? it,
        minutes === undefined ? "limit" : `${Math.round(minutes)}m`,
        minutes,
      );
      if (row) windows.push(row);
    }
  }

  if (p.parallel && typeof p.parallel === "object") {
    const par = /** @type {Record<string, unknown>} */ (p.parallel);
    const limit = toNumber(par.limit);
    if (limit !== undefined && limit > 0) {
      const used = Array.isArray(par.details) ? par.details.length : 0;
      windows.push({
        id: "parallel-sessions",
        label: "parallel sessions",
        unit: "count",
        used,
        limit,
        remaining: Math.max(limit - used, 0),
      });
    }
  }

  let planType;
  if (p.user && typeof p.user === "object") {
    const membership = /** @type {Record<string, unknown>} */ (p.user).membership;
    if (membership && typeof membership === "object") {
      const level = /** @type {Record<string, unknown>} */ (membership).level;
      if (typeof level === "string" && level.startsWith("LEVEL_")) {
        planType = level.slice("LEVEL_".length).toLowerCase();
      }
    }
  }

  return { windows, planType };
}
