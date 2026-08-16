/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Builds one percent window from a `{ utilization, resets_at }` block as
 * returned by `GET https://api.anthropic.com/api/oauth/usage`.
 *
 * @param {unknown} block
 * @param {string} id
 * @param {string} label
 * @returns {UsageWindow | undefined}
 */
function windowFrom(block, id, label) {
  if (!block || typeof block !== "object") return undefined;
  const util = /** @type {{ utilization?: unknown }} */ (block).utilization;
  if (typeof util !== "number") return undefined;
  const resetsAt = /** @type {{ resets_at?: unknown }} */ (block).resets_at;
  return {
    id,
    label,
    unit: "percent",
    usedPercent: util,
    resetsAt: typeof resetsAt === "string" ? resetsAt : undefined,
  };
}

/**
 * Labels and plan-cap metadata for known per-model weekly windows, keyed by
 * the lowercased model display name the endpoint reports.
 *
 * @type {Record<string, { id: string; label: string; capPercent?: number }>}
 */
const MODEL_WINDOWS = {
  opus: { id: "weekly-opus", label: "weekly (Opus)" },
  sonnet: { id: "weekly-sonnet", label: "weekly (Sonnet)" },
  fable: { id: "weekly-fable", label: "weekly (Fable, 50% plan cap)", capPercent: 50 },
};

/**
 * Reads the model display name out of a `limits[]` entry scope.
 *
 * @param {unknown} scope
 * @returns {string | undefined}
 */
function scopedModelName(scope) {
  if (!scope || typeof scope !== "object") return undefined;
  const model = /** @type {{ model?: unknown }} */ (scope).model;
  if (!model || typeof model !== "object") return undefined;
  const name = /** @type {{ display_name?: unknown }} */ (model).display_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Builds one percent window from a `limits[]` entry as returned by
 * `GET https://api.anthropic.com/api/oauth/usage`. Entries use
 * `{ kind, percent, resets_at, scope }` instead of the
 * `{ utilization, resets_at }` shape of the top-level blocks.
 *
 * @param {unknown} entry
 * @returns {{ id: string; window: UsageWindow } | undefined}
 */
function windowFromLimit(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (e.kind !== "weekly_scoped") return undefined;
  const name = scopedModelName(e.scope);
  if (!name) return undefined;
  if (typeof e.percent !== "number") return undefined;
  const known = MODEL_WINDOWS[name.toLowerCase()];
  const id = known?.id ?? `weekly-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const label = known?.label ?? `weekly (${name})`;
  /** @type {UsageWindow} */
  const window = {
    id,
    label,
    unit: "percent",
    usedPercent: e.percent,
    resetsAt: typeof e.resets_at === "string" ? e.resets_at : undefined,
  };
  if (known?.capPercent !== undefined) window.capPercent = known.capPercent;
  return { id, window };
}

/**
 * Normalizes the Claude Code subscription usage payload into usage windows. The
 * payload powers the in-CLI `/usage` view: a 5-hour rolling window, a weekly
 * window, and optional per-model weekly windows.
 *
 * Per-model windows come from two shapes. Current payloads carry them in
 * `limits[]` as `kind: "weekly_scoped"` entries with
 * `scope.model.display_name` (for example "Fable"). Older payloads carried
 * dedicated `seven_day_<model>` blocks. Both parse to the same window ids.
 *
 * @param {unknown} payload
 * @returns {UsageWindow[]}
 */
export function parseClaudeOauthUsage(payload) {
  if (!payload || typeof payload !== "object") return [];
  const p = /** @type {Record<string, unknown>} */ (payload);
  const windows = [];
  const fiveHour = windowFrom(p.five_hour, "5h", "5-hour session");
  if (fiveHour) windows.push(fiveHour);
  const weekly = windowFrom(p.seven_day, "weekly", "weekly");
  if (weekly) windows.push(weekly);
  const opus = windowFrom(p.seven_day_opus, "weekly-opus", "weekly (Opus)");
  if (opus) windows.push(opus);
  const sonnet = windowFrom(p.seven_day_sonnet, "weekly-sonnet", "weekly (Sonnet)");
  if (sonnet) windows.push(sonnet);
  const fable = windowFrom(p.seven_day_fable, "weekly-fable", "weekly (Fable, 50% plan cap)");
  if (fable) {
    fable.capPercent = 50;
    windows.push(fable);
  }
  if (Array.isArray(p.limits)) {
    for (const entry of p.limits) {
      const parsed = windowFromLimit(entry);
      if (parsed && !windows.some((w) => w.id === parsed.id)) windows.push(parsed.window);
    }
  }
  return windows;
}
