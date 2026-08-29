/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Builds one percent window from a `{ utilization, resets_at }` block as
 * returned by `GET https://api.anthropic.com/api/oauth/usage`.
 *
 * @param {unknown} block
 * @param {string} id
 * @param {string} label
 * @param {string} [modelScope]
 * @returns {UsageWindow | undefined}
 */
function windowFrom(block, id, label, modelScope) {
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
    ...(modelScope ? { modelScope } : {}),
  };
}

/**
 * Builds one percent window from an entry of the payload's `limits` array, the
 * generic shape that superseded the fixed `seven_day_*` blocks. Known kinds:
 * `session` (the 5-hour window), `weekly_all` (the all-models weekly window),
 * and `weekly_scoped` (a weekly window capping one model family, e.g. Fable,
 * identified only by `scope.model.display_name`). Unknown kinds and malformed
 * entries are skipped, never fatal.
 *
 * @param {unknown} entry
 * @returns {UsageWindow | undefined}
 */
function windowFromLimit(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.percent !== "number") return undefined;
  const resetsAt = typeof e.resets_at === "string" ? e.resets_at : undefined;
  if (e.kind === "session") {
    return { id: "5h", label: "5-hour session", unit: "percent", usedPercent: e.percent, resetsAt };
  }
  if (e.kind === "weekly_all") {
    return { id: "weekly", label: "weekly", unit: "percent", usedPercent: e.percent, resetsAt };
  }
  if (e.kind === "weekly_scoped") {
    const scope = /** @type {{ model?: { display_name?: unknown } } | null | undefined} */ (e.scope);
    const displayName = scope?.model?.display_name;
    if (typeof displayName !== "string" || displayName.length === 0) return undefined;
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      id: `weekly-${slug}`,
      label: `weekly (${displayName})`,
      unit: "percent",
      usedPercent: e.percent,
      resetsAt,
      modelScope: slug,
    };
  }
  return undefined;
}

/**
 * Normalizes the Claude Code subscription usage payload into usage windows. The
 * payload powers the in-CLI `/usage` view: a 5-hour rolling window, a weekly
 * window, and per-model weekly windows. Model-scoped windows arrive through the
 * legacy fixed blocks (`seven_day_opus`, `seven_day_sonnet`) on old payloads
 * and through the generic `limits` array on current ones (which is the only
 * place a Fable-scoped weekly window ever appears); when both describe the same
 * window id, the `limits` entry wins.
 *
 * @param {unknown} payload
 * @returns {UsageWindow[]}
 */
export function parseClaudeOauthUsage(payload) {
  if (!payload || typeof payload !== "object") return [];
  const p = /** @type {Record<string, unknown>} */ (payload);
  /** @type {Map<string, UsageWindow>} */
  const byId = new Map();
  /** @type {string[]} */
  const order = [];
  const push = (/** @type {UsageWindow | undefined} */ w) => {
    if (!w) return;
    const previous = byId.get(w.id);
    if (!previous) order.push(w.id);
    // `limits[]` reports utilization but never the plan share a scoped cap is
    // worth, so a later entry inherits the `capPercent` the legacy block knew.
    if (previous?.capPercent !== undefined && w.capPercent === undefined) w.capPercent = previous.capPercent;
    byId.set(w.id, w);
  };
  push(windowFrom(p.five_hour, "5h", "5-hour session"));
  push(windowFrom(p.seven_day, "weekly", "weekly"));
  push(windowFrom(p.seven_day_opus, "weekly-opus", "weekly (Opus)", "opus"));
  push(windowFrom(p.seven_day_sonnet, "weekly-sonnet", "weekly (Sonnet)", "sonnet"));
  const legacyFable = windowFrom(p.seven_day_fable, "weekly-fable", "weekly (Fable, 50% plan cap)", "fable");
  if (legacyFable) {
    legacyFable.capPercent = 50;
    push(legacyFable);
  }
  if (Array.isArray(p.limits)) {
    for (const entry of p.limits) push(windowFromLimit(entry));
  }
  return order.map((id) => /** @type {UsageWindow} */ (byId.get(id)));
}
