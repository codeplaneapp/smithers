/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */
/** @typedef {import("./accountSelection.js").readAccountQuotaState} readAccountQuotaState */

/**
 * Derives a best-effort Fable window from a persisted model-scoped quota
 * event. The Claude usage endpoint does not always report a Fable window, but
 * a recorded Fable rejection (`<label>::fable` in account-quota-state.json)
 * still pinpoints the cap: the window is full until the recorded reset.
 *
 * The derived window is marked `unit: "estimated"` and `estimate: true` so
 * renderers can distinguish it from provider-authoritative windows.
 *
 * @param {UsageReport} report
 * @param {ReturnType<typeof readAccountQuotaState>["entries"]} entries Quota-state entries, already filtered to unexpired rows.
 * @returns {UsageReport}
 */
export function withFableQuotaEstimate(report, entries) {
  if (report.provider !== "claude-code") return report;
  if (report.windows.some((window) => window.id === "weekly-fable")) return report;
  const entry = entries[`${report.accountLabel}::fable`];
  if (!entry) return report;
  /** @type {UsageWindow} */
  const window = {
    id: "weekly-fable",
    label: "weekly (Fable, 50% plan cap)",
    unit: "estimated",
    usedPercent: 100,
    resetsAt: new Date(entry.untilMs).toISOString(),
    capPercent: 50,
    estimate: true,
  };
  return { ...report, windows: [...report.windows, window] };
}
