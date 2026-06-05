/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Maps a Codex rate-limit window's duration (in minutes) to a stable id/label.
 * The Codex TUI labels windows the same way: ~300 min is the 5-hour window,
 * ~10080 min is the weekly window.
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
 * Builds a percent window from a Codex `{ used_percent, window_minutes, reset_at }`
 * block. `reset_at` is unix seconds.
 *
 * @param {unknown} block
 * @param {string} fallbackId
 * @returns {UsageWindow | undefined}
 */
function windowFrom(block, fallbackId) {
    if (!block || typeof block !== "object") return undefined;
    const b = /** @type {Record<string, unknown>} */ (block);
    const usedPercent = typeof b.used_percent === "number" ? b.used_percent : undefined;
    if (usedPercent === undefined) return undefined;
    const minutes = typeof b.window_minutes === "number" ? b.window_minutes : undefined;
    const { id, label } = labelForMinutes(minutes, fallbackId);
    let resetsAt;
    if (typeof b.reset_at === "number" && Number.isFinite(b.reset_at)) {
        resetsAt = new Date(b.reset_at * 1000).toISOString();
    }
    return { id, label, unit: "percent", usedPercent, resetsAt };
}

/**
 * Normalizes the Codex usage payload (from `GET /backend-api/wham/usage`, or the
 * `codex.rate_limits` event) into windows plus plan and credit metadata. The
 * rate-limit object may sit at the top level or under a `rate_limits` key; both
 * shapes are accepted.
 *
 * @param {unknown} payload
 * @returns {{ windows: UsageWindow[]; planType?: string; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string } }}
 */
export function parseCodexUsage(payload) {
    if (!payload || typeof payload !== "object") return { windows: [] };
    const p = /** @type {Record<string, unknown>} */ (payload);
    const rl = /** @type {Record<string, unknown>} */ (
        p.rate_limits && typeof p.rate_limits === "object" ? p.rate_limits : p
    );
    const windows = [];
    const primary = windowFrom(rl.primary, "primary");
    if (primary) windows.push(primary);
    const secondary = windowFrom(rl.secondary, "secondary");
    if (secondary) windows.push(secondary);

    const planRaw = p.plan_type ?? rl.plan_type;
    const planType = typeof planRaw === "string" ? planRaw : undefined;

    const creditsRaw = p.credits ?? rl.credits;
    let credits;
    if (creditsRaw && typeof creditsRaw === "object") {
        const c = /** @type {Record<string, unknown>} */ (creditsRaw);
        credits = {
            hasCredits: Boolean(c.has_credits),
            unlimited: Boolean(c.unlimited),
            balance: typeof c.balance === "string" ? c.balance : undefined,
        };
    }
    return { windows, planType, credits };
}
