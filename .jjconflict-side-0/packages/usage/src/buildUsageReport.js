import { API_KEY_PROVIDERS } from "@smithers-orchestrator/accounts";

/** @typedef {import("@smithers-orchestrator/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {import("./UsageWindow.ts").UsageWindow} UsageWindow */

/**
 * The partial result an adapter returns. The dispatcher wraps it with the
 * account identity and timestamp to form a complete {@link UsageReport}.
 *
 * @typedef {object} UsageProbe
 * @property {import("./UsageSource.ts").UsageSource} source
 * @property {UsageWindow[]} [windows]
 * @property {string} [planType]
 * @property {{ hasCredits: boolean; unlimited: boolean; balance?: string }} [credits]
 * @property {boolean} [estimate]
 * @property {string} [error]
 */

/**
 * Assembles a full usage report from an account and an adapter probe. Keeps the
 * adapters free of repeated identity/timestamp boilerplate.
 *
 * @param {Account} account
 * @param {UsageProbe} probe
 * @param {{ nowIso?: string }} [options]
 * @returns {UsageReport}
 */
export function buildUsageReport(account, probe, options = {}) {
    return {
        accountLabel: account.label,
        provider: account.provider,
        authMode: API_KEY_PROVIDERS.has(account.provider) ? "api-key" : "subscription",
        source: probe.source,
        windows: probe.windows ?? [],
        planType: probe.planType,
        credits: probe.credits,
        fetchedAt: options.nowIso ?? new Date().toISOString(),
        stale: false,
        estimate: probe.estimate ?? false,
        error: probe.error,
    };
}
