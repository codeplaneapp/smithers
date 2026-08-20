import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountsRoot, withAccountsLock } from "@smthrs/accounts";
import { readUsageCache } from "./usageCache.js";
import { foldModelUsageEvents } from "./modelUsage.js";

/** @typedef {import("@smthrs/accounts").Account} Account */
/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */

const UNKNOWN_QUOTA_TTL_MS = 5 * 60_000;

/** @param {NodeJS.ProcessEnv} [env] */
export function accountQuotaStatePath(env = process.env) {
  return join(accountsRoot(env), "account-quota-state.json");
}

/**
 * Read persisted account quota blocks. Expired and malformed entries are
 * ignored so an old marker never disables an account permanently.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {number} [nowMs]
 * @returns {{ version: 1; entries: Record<string, { untilMs: number; model?: string; observedAt: string }> }}
 */
export function readAccountQuotaState(env = process.env, nowMs = Date.now()) {
  const path = accountQuotaStatePath(env);
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    const entries = {};
    for (const [label, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== "object") continue;
      const untilMs = /** @type {{ untilMs?: unknown }} */ (entry).untilMs;
      if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= nowMs) continue;
      entries[label] = {
        untilMs,
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        observedAt: typeof entry.observedAt === "string" ? entry.observedAt : new Date(nowMs).toISOString(),
      };
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

/** @param {ReturnType<typeof readAccountQuotaState>} state @param {NodeJS.ProcessEnv} env */
function writeAccountQuotaState(state, env) {
  const path = accountQuotaStatePath(env);
  mkdirSync(accountsRoot(env), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Persist a provider-reported quota reset for an account. A short bounded TTL
 * is used when the provider omits a reset, which prevents immediate hammering
 * without permanently disabling the account.
 *
 * @param {string} label
 * @param {{ untilMs?: number; model?: string; scope?: "shared" | "model"; nowMs?: number; env?: NodeJS.ProcessEnv }} [options]
 */
export function recordAccountQuotaLimit(label, options = {}) {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const untilMs =
    typeof options.untilMs === "number" && Number.isFinite(options.untilMs) && options.untilMs > nowMs
      ? options.untilMs
      : nowMs + UNKNOWN_QUOTA_TTL_MS;
  return withAccountsLock(env, () => {
    const state = readAccountQuotaState(env, nowMs);
    const family = modelFamily(options.model);
    const key = options.scope === "model" && family !== "shared" ? `${label}::${family}` : label;
    const effectiveUntilMs = Math.max(untilMs, state.entries[key]?.untilMs ?? 0);
    state.entries[key] = {
      untilMs: effectiveUntilMs,
      ...(options.model ? { model: options.model } : {}),
      observedAt: new Date(nowMs).toISOString(),
    };
    writeAccountQuotaState(state, env);
    return state.entries[key];
  });
}

/** @param {string} label @param {NodeJS.ProcessEnv} [env] */
export function clearAccountQuotaLimit(label, env = process.env) {
  return withAccountsLock(env, () => {
    // Read all syntactically valid entries, including expired ones. Clearing an
    // account is an explicit cleanup operation and must also remove stale rows.
    const state = readAccountQuotaState(env, 0);
    const keys = Object.keys(state.entries).filter((key) => key === label || key.startsWith(`${label}::`));
    if (keys.length === 0) return false;
    for (const key of keys) delete state.entries[key];
    writeAccountQuotaState(state, env);
    return true;
  });
}

/** @param {string | undefined} model */
function modelFamily(model) {
  const value = model?.toLowerCase() ?? "";
  if (value.includes("fable")) return "fable";
  if (value.includes("opus")) return "opus";
  if (value.includes("sonnet")) return "sonnet";
  return "shared";
}

/**
 * Find the quota block that applies to a model. Shared blocks apply to every
 * model. Fable, Opus, and Sonnet blocks apply only to their own family. When
 * both apply, the later reset is when the account becomes usable.
 *
 * @param {ReturnType<typeof readAccountQuotaState>["entries"]} entries
 * @param {string} label
 * @param {string | undefined} model
 * @param {UsageReport | undefined} [report]
 * @param {number} [nowMs]
 */
export function accountQuotaBlock(entries, label, model, report, nowMs = Date.now()) {
  const blocks = [entries[label]];
  const family = modelFamily(model);
  if (family !== "shared") blocks.push(entries[`${label}::${family}`]);
  const usageBlock = exhaustedUsageBlock(report, model, nowMs);
  if (usageBlock) blocks.push(usageBlock);
  return blocks.filter(Boolean).sort((a, b) => b.untilMs - a.untilMs)[0];
}

/**
 * Treat a persisted 100% usage window as a known quota block. If several
 * applicable windows are exhausted, the account is usable only after the
 * latest one resets.
 *
 * @param {UsageReport | undefined} report
 * @param {string | undefined} model
 * @param {number} nowMs
 */
function exhaustedUsageBlock(report, model, nowMs) {
  if (!report || report.source === "none") return undefined;
  const family = modelFamily(model);
  const relevant = new Set(["5h", "weekly"]);
  if (family !== "shared") relevant.add(`weekly-${family}`);
  const exhausted = report.windows.filter((window) => {
    if (!relevant.has(window.id)) return false;
    let usedPercent = window.usedPercent;
    if (family === "fable" && window.id === "weekly" && !report.windows.some((row) => row.id === "weekly-fable")) {
      usedPercent = typeof usedPercent === "number" ? usedPercent * 2 : usedPercent;
    }
    return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= 100;
  });
  if (exhausted.length === 0) return undefined;
  const resetTimes = exhausted.flatMap((window) => {
    const resetMs = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
    if (Number.isFinite(resetMs)) return resetMs > nowMs ? [resetMs] : [];
    return [nowMs + UNKNOWN_QUOTA_TTL_MS];
  });
  if (resetTimes.length === 0) return undefined;
  const untilMs = Math.max(...resetTimes);
  return {
    untilMs,
    ...(model ? { model } : {}),
    observedAt: report.fetchedAt,
  };
}

/** @param {UsageReport | undefined} report @param {string | undefined} model */
export function accountUsageScore(report, model) {
  if (!report || report.source === "none") return 101;
  const family = modelFamily(model);
  const ids = new Set(["5h", "weekly"]);
  if (family !== "shared") ids.add(`weekly-${family}`);
  const matching = report.windows.filter((window) => ids.has(window.id));
  const values = matching
    .map((window) => window.usedPercent)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  // Older usage payloads omit seven_day_fable. Fable consumes only 50% of
  // the weekly plan, so normalize shared weekly consumption against that cap
  // when the provider does not supply the dedicated window.
  if (family === "fable" && !matching.some((window) => window.id === "weekly-fable")) {
    const weekly = report.windows.find((window) => window.id === "weekly")?.usedPercent;
    if (typeof weekly === "number" && Number.isFinite(weekly)) values.push(Math.min(100, weekly * 2));
  }
  return values.length > 0 ? Math.max(...values) : 100;
}

/**
 * Order registered accounts from most headroom to least. Persisted quota-dead
 * accounts sort last, with the soonest reset first. The caller can replace
 * those rows with no-network quota sentinels instead of probing them again.
 *
 * @param {Account[]} accounts
 * @param {{ env?: NodeJS.ProcessEnv; modelFor?: (account: Account) => string | undefined; nowMs?: number; tieBreak?: Map<string, number>; modelEventsFor?: (account: Account) => Iterable<unknown> | undefined }} [options]
 */
export function orderAccountsByUsage(accounts, options = {}) {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const reports = readUsageCache(env).entries;
  const quota = readAccountQuotaState(env, nowMs).entries;
  const modelFor = options.modelFor ?? ((account) => account.model);
  const modelUsage = new Map(accounts.map((account) => [account.label, options.modelEventsFor ? foldModelUsageEvents(options.modelEventsFor(account) ?? []).totalTokens : 0]));
  return [...accounts].sort((a, b) => {
    const aq = accountQuotaBlock(quota, a.label, modelFor(a), reports[a.label]?.report, nowMs);
    const bq = accountQuotaBlock(quota, b.label, modelFor(b), reports[b.label]?.report, nowMs);
    if (Boolean(aq) !== Boolean(bq)) return aq ? 1 : -1;
    if (aq && bq && aq.untilMs !== bq.untilMs) return aq.untilMs - bq.untilMs;
    const score =
      accountUsageScore(reports[a.label]?.report, modelFor(a)) -
      accountUsageScore(reports[b.label]?.report, modelFor(b));
    if (score !== 0) return score;
    const tokenDelta = (modelUsage.get(a.label) ?? 0) - (modelUsage.get(b.label) ?? 0);
    if (tokenDelta !== 0) return tokenDelta;
    const tie = (options.tieBreak?.get(a.label) ?? 0) - (options.tieBreak?.get(b.label) ?? 0);
    return tie !== 0 ? tie : a.label.localeCompare(b.label);
  });
}
