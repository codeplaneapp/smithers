import { formatRelativeReset } from "./formatRelativeReset.js";

/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * Renders the "used" cell for one window.
 *
 * @param {UsageWindow} w
 * @returns {string}
 */
function usedCell(w) {
    if (w.unit === "percent") {
        return w.usedPercent === undefined ? "" : `${Math.round(w.usedPercent)}%`;
    }
    if (w.unit === "estimated") {
        if (w.used !== undefined && w.limit !== undefined) return `~${w.used}/${w.limit}`;
        if (w.usedPercent !== undefined) return `~${Math.round(w.usedPercent)}%`;
        return "~?";
    }
    // count
    if (w.remaining !== undefined && w.limit !== undefined) return `${w.remaining}/${w.limit} left`;
    if (w.remaining !== undefined) return `${w.remaining} left`;
    if (w.used !== undefined && w.limit !== undefined) return `${w.used}/${w.limit}`;
    return "";
}

/**
 * Renders an array of usage reports as an aligned text table. Pure: pass a fixed
 * `nowMs` in tests to get deterministic "resets in" values.
 *
 * @param {UsageReport[]} reports
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatUsageReports(reports, nowMs = Date.now()) {
    if (reports.length === 0) {
        return "No accounts registered. Add one with `smithers agents add`.";
    }
    const header = ["ACCOUNT", "PROVIDER", "PLAN", "WINDOW", "USED", "RESETS IN"];
    /** @type {string[][]} */
    const rows = [header];
    for (const r of reports) {
        const plan = r.planType ?? (r.authMode === "api-key" ? "—" : "");
        if (r.windows.length === 0) {
            const note = r.error ?? (r.source === "none" ? "not supported" : "");
            rows.push([r.accountLabel, r.provider, plan, "—", note, ""]);
            continue;
        }
        for (const w of r.windows) {
            const used = usedCell(w) + (w.unit === "estimated" ? " (est)" : "");
            rows.push([r.accountLabel, r.provider, plan, w.label, used, formatRelativeReset(w.resetsAt, nowMs)]);
        }
    }
    const widths = header.map((_, col) => Math.max(...rows.map((row) => row[col].length)));
    return rows
        .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd())
        .join("\n");
}
