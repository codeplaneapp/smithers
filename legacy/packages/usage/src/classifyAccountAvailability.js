/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * @typedef {object} AccountAvailability
 * @property {"ok" | "degraded" | "blocked" | "unknown"} status
 *   `blocked` — an account-wide window (5-hour session, weekly all-models) is
 *   exhausted: the account cannot serve any request until it resets.
 *   `degraded` — only a model-scoped window (e.g. the Fable weekly cap) is
 *   exhausted: the account still serves other models.
 *   `ok` — every reported window has headroom.
 *   `unknown` — no windows to judge (probe failed or provider reports none).
 * @property {string[]} reasons Labels of the exhausted windows, blocked first.
 */

/**
 * A window whose reset time has already passed has rolled over; its recorded
 * utilization describes the previous period, so it reads as fresh (0 used).
 *
 * @param {UsageWindow} w
 * @param {number} nowMs
 * @returns {number | undefined} effective used percent, undefined when the
 *   window carries no percent utilization.
 */
export function effectiveUsedPercent(w, nowMs) {
  if (typeof w.usedPercent !== "number") return undefined;
  if (typeof w.resetsAt === "string") {
    const resetMs = Date.parse(w.resetsAt);
    if (Number.isFinite(resetMs) && resetMs <= nowMs) return 0;
  }
  return w.usedPercent;
}

/**
 * Classifies one account's usage windows into a traffic-light availability:
 * blocked (rate-limited for everything), degraded (a model-scoped cap such as
 * the Fable weekly limit is exhausted, other models still work), or ok. Pure —
 * pass `nowMs` for deterministic tests.
 *
 * @param {UsageWindow[]} windows
 * @param {number} [nowMs]
 * @returns {AccountAvailability}
 */
export function classifyAccountAvailability(windows, nowMs = Date.now()) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return { status: "unknown", reasons: [] };
  }
  /** @type {string[]} */
  const blocked = [];
  /** @type {string[]} */
  const degraded = [];
  for (const w of windows) {
    const used = effectiveUsedPercent(w, nowMs);
    const exhausted =
      used !== undefined ? used >= 100 : w.unit === "count" && w.remaining !== undefined && w.remaining <= 0;
    if (!exhausted) continue;
    (w.modelScope ? degraded : blocked).push(`${w.label} exhausted`);
  }
  if (blocked.length > 0) return { status: "blocked", reasons: [...blocked, ...degraded] };
  if (degraded.length > 0) return { status: "degraded", reasons: degraded };
  return { status: "ok", reasons: [] };
}
