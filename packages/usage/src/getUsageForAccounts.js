import { getAccountUsage } from "./getAccountUsage.js";
import { readUsageCache, writeUsageCache } from "./usageCache.js";

/** @typedef {import("@smithers-orchestrator/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */

/**
 * Soft refresh interval: within this age a cached report is reused on a normal
 * run. `--fresh` bypasses it.
 *
 * @param {string} provider
 * @returns {number}
 */
function refreshIntervalMs(provider) {
    switch (provider) {
        case "claude-code": return 180_000;
        case "codex": return 60_000;
        default: return 30_000;
    }
}

/**
 * Hard floor: never re-probe faster than this, even with `--fresh`. The Claude
 * usage endpoint 429s aggressively below 180s, so we protect it unconditionally.
 *
 * @param {string} provider
 * @returns {number}
 */
function hardFloorMs(provider) {
    return provider === "claude-code" ? 180_000 : 0;
}

/**
 * Gathers usage for many accounts in parallel, served through the on-disk cache.
 * Cached reports come back with `stale: true`. The cache is read once and written
 * once, so parallel probes never race on the file.
 *
 * @param {Account[]} accounts
 * @param {{ fresh?: boolean; env?: NodeJS.ProcessEnv; nowMs?: number }} [options]
 * @returns {Promise<UsageReport[]>}
 */
export async function getUsageForAccounts(accounts, options = {}) {
    const { fresh = false, env = process.env, nowMs = Date.now() } = options;
    const cache = readUsageCache(env);
    const decisions = accounts.map((account) => {
        const entry = cache.entries[account.label];
        const age = entry ? nowMs - Date.parse(entry.report.fetchedAt) : Infinity;
        const useCache = Boolean(entry) && (
            age < hardFloorMs(account.provider) ||
            (!fresh && age < refreshIntervalMs(account.provider))
        );
        return { account, entry, useCache };
    });
    const reports = await Promise.all(decisions.map(async (d) => {
        if (d.useCache && d.entry) return { ...d.entry.report, stale: true };
        return getAccountUsage(d.account);
    }));
    let changed = false;
    reports.forEach((report, i) => {
        if (!decisions[i].useCache) {
            cache.entries[report.accountLabel] = { report };
            changed = true;
        }
    });
    if (changed) {
        try {
            writeUsageCache(cache, env);
        } catch {
            // a cache write failure must not break the command
        }
    }
    return reports;
}
