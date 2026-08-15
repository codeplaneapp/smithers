import { createHash } from "node:crypto";
import { getAccountUsage } from "./getAccountUsage.js";
import { readUsageCache, writeUsageCache } from "./usageCache.js";
import { readClaudeCredentials } from "./readClaudeCredentials.js";

/** @typedef {import("@smthrs/accounts").Account} Account */
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
    case "claude-code":
      return 180_000;
    case "codex":
      return 60_000;
    default:
      return 30_000;
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
 * The floor exists to space out *successful* probes of the rate-limited endpoint.
 * A cached failure carries no numbers, so pinning it under the floor only blinds
 * the view for 3 minutes — a refreshed token or a recovered endpoint could not be
 * re-probed at all. Failures stay cacheable (the soft interval still shields the
 * endpoint on normal runs) but `--fresh` may clear them.
 *
 * @param {{ report?: UsageReport } | undefined} entry
 * @returns {boolean}
 */
function entryFailed(entry) {
  return entry?.report?.source === "none";
}

/**
 * Builds a credential-safe identity for a cached report. The API key digest
 * distinguishes replacements without persisting the key itself.
 *
 * @param {Account} account
 * @returns {{ provider: Account["provider"]; configDir?: string; model?: string; apiKeyHash?: string; credentialHash?: string }}
 */
function accountIdentity(account) {
  const identity = { provider: account.provider };
  if (account.configDir !== undefined) identity.configDir = account.configDir;
  if (account.model !== undefined) identity.model = account.model;
  if (account.apiKey !== undefined) {
    identity.apiKeyHash = createHash("sha256").update(account.apiKey).digest("hex");
  }
  if (account.provider === "claude-code") {
    const accessToken = readClaudeCredentials(account)?.accessToken;
    if (accessToken) identity.credentialHash = createHash("sha256").update(accessToken).digest("hex");
  }
  return identity;
}

/**
 * @param {{ identity?: ReturnType<typeof accountIdentity> } | undefined} entry
 * @param {ReturnType<typeof accountIdentity>} identity
 * @returns {boolean}
 */
function entryMatchesAccount(entry, identity) {
  return (
    entry?.identity?.provider === identity.provider &&
    entry.identity.configDir === identity.configDir &&
    entry.identity.model === identity.model &&
    entry.identity.apiKeyHash === identity.apiKeyHash &&
    entry.identity.credentialHash === identity.credentialHash
  );
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
    const identity = accountIdentity(account);
    const fetchedAt = entry?.report?.fetchedAt;
    const ageMs = typeof fetchedAt === "string" ? nowMs - Date.parse(fetchedAt) : Number.NaN;
    const useCache =
      entryMatchesAccount(entry, identity) &&
      Number.isFinite(ageMs) &&
      ((!entryFailed(entry) && ageMs < hardFloorMs(account.provider)) ||
        (!fresh && ageMs < refreshIntervalMs(account.provider)));
    return { account, entry, identity, useCache };
  });
  const reports = await Promise.all(
    decisions.map(async (d) => {
      if (d.useCache && d.entry) return { ...d.entry.report, stale: true };
      return getAccountUsage(d.account);
    }),
  );
  let changed = false;
  reports.forEach((report, i) => {
    if (!decisions[i].useCache) {
      cache.entries[report.accountLabel] = { identity: decisions[i].identity, report };
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
