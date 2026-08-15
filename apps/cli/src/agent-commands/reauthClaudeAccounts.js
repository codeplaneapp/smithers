import { spawnSync } from "node:child_process";
import { listAccounts } from "@smthrs/accounts";
import { claudeKeychainSuffix, claudeOauthUsage, clearAccountUsageCache, readClaudeCredentials } from "@smthrs/usage";
import {
  findDuplicateAccounts,
  formatAccountIdentity,
  readAccountIdentity,
  readDefaultClaudeIdentity,
} from "./accountIdentity.js";

const REFRESH_PROBE_ARGS = [
  "--print",
  "--safe-mode",
  "--tools",
  "",
  "--model",
  "haiku",
  "--no-session-persistence",
  "--output-format",
  "json",
  "--max-budget-usd",
  "0.000001",
  "Reply with exactly OK.",
];

/** @param {{ configDir?: string }} account @param {NodeJS.ProcessEnv} base */
function claudeEnv(account, base) {
  const env = { ...base, ANTHROPIC_API_KEY: "" };
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/** @param {ReturnType<typeof spawnSync>} result */
function authStatusLoggedIn(result) {
  if (result.status !== 0) return false;
  try {
    return JSON.parse(result.stdout?.toString("utf8") ?? "{}").loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Test whether one Claude login is live. An expired access token gets one
 * minimal Haiku request so Claude Code can refresh it with the stored refresh
 * token. A quota banner proves authentication is live and does not trigger a
 * browser login.
 *
 * @param {{ configDir?: string }} account
 * @param {{ env: NodeJS.ProcessEnv; spawn: typeof spawnSync; usageProbe: typeof claudeOauthUsage; readCredentials: typeof readClaudeCredentials }} deps
 */
async function probeClaudeLogin(account, deps) {
  const env = claudeEnv(account, deps.env);
  const credentials = deps.readCredentials(account);
  if (credentials && (credentials.expiresAt === undefined || credentials.expiresAt > Date.now())) {
    const usage = await deps.usageProbe(account);
    if (usage.source === "oauth") return { live: true, refreshed: false, usage };
    if (usage.error?.includes("429")) {
      const status = deps.spawn("claude", ["auth", "status", "--json"], { env, encoding: "utf8" });
      if (authStatusLoggedIn(status)) return { live: true, refreshed: false, usage };
    }
  }
  const status = deps.spawn("claude", ["auth", "status", "--json"], { env, encoding: "utf8" });
  if (!authStatusLoggedIn(status)) return { live: false, refreshed: false };
  const refresh = deps.spawn("claude", REFRESH_PROBE_ARGS, { env, encoding: "utf8", timeout: 60_000 });
  const output = `${refresh.stdout ?? ""}\n${refresh.stderr ?? ""}`;
  const quotaProvesLive = /usage|session|weekly|rate.{0,8}limit/i.test(output);
  if (refresh.status !== 0 && !quotaProvesLive) return { live: false, refreshed: false };
  const next = deps.readCredentials(account);
  if (!next) return { live: false, refreshed: false };
  const usage = await deps.usageProbe(account);
  return { live: refresh.status === 0 || usage.source === "oauth" || quotaProvesLive, refreshed: true, usage };
}

/** @param {{ configDir?: string }} account @param {NodeJS.ProcessEnv} env @param {typeof spawnSync} spawn */
function clearClaudeLogin(account, env, spawn) {
  const accountEnv = claudeEnv(account, env);
  spawn("claude", ["auth", "logout"], { env: accountEnv, encoding: "utf8" });
  if (process.platform !== "darwin") return;
  const service = account.configDir
    ? `Claude Code-credentials-${claudeKeychainSuffix(account.configDir)}`
    : "Claude Code-credentials";
  // Claude Code can leave an unreadable or stale item behind. Deleting the
  // exact service prevents the next browser flow from silently reusing it.
  spawn("security", ["delete-generic-password", "-s", service], { env, encoding: "utf8" });
}

/**
 * Reauthenticate registered Claude accounts sequentially.
 *
 * @param {{ force?: boolean; label?: string; includeDefault?: boolean; env?: NodeJS.ProcessEnv; accounts?: import("@smthrs/accounts").Account[]; spawn?: typeof spawnSync; usageProbe?: typeof claudeOauthUsage; readCredentials?: typeof readClaudeCredentials; onStatus?: (message: string) => void }} [input]
 */
export async function reauthClaudeAccounts(input = {}) {
  const env = input.env ?? process.env;
  const spawn = input.spawn ?? spawnSync;
  const usageProbe = input.usageProbe ?? claudeOauthUsage;
  const readCredentials = input.readCredentials ?? readClaudeCredentials;
  const onStatus = input.onStatus ?? (() => {});
  const registered = (input.accounts ?? listAccounts(env)).filter((account) => account.provider === "claude-code");
  const targets = [
    ...registered,
    ...(input.includeDefault ? [{ label: "default", provider: "claude-code", isDefault: true }] : []),
  ].filter((account) => !input.label || account.label === input.label);
  if (input.label && targets.length === 0) {
    throw new Error(`No Claude account with label "${input.label}" is registered.`);
  }
  const results = [];
  for (const account of targets) {
    onStatus(`Checking ${account.label}...`);
    const health = input.force
      ? { live: false, refreshed: false }
      : await probeClaudeLogin(account, { env, spawn, usageProbe, readCredentials });
    let reauthenticated = false;
    if (!health.live) {
      onStatus(`${account.label} needs browser authentication.`);
      clearClaudeLogin(account, env, spawn);
      const login = spawn("claude", ["auth", "login", "--claudeai"], {
        env: claudeEnv(account, env),
        stdio: "inherit",
      });
      if (login.status !== 0 || !readCredentials(account)) {
        results.push({
          label: account.label,
          ok: false,
          reauthenticated: false,
          error: "login did not produce credentials",
        });
        onStatus(`${account.label}: login did not produce a credential artifact.`);
        continue;
      }
      const verified = await usageProbe(account);
      const status = spawn("claude", ["auth", "status", "--json"], {
        env: claudeEnv(account, env),
        encoding: "utf8",
      });
      if (verified.source !== "oauth" && !authStatusLoggedIn(status)) {
        results.push({
          label: account.label,
          ok: false,
          reauthenticated: true,
          error: verified.error ?? "liveness probe failed",
        });
        onStatus(`${account.label}: credentials appeared, but the liveness probe failed.`);
        continue;
      }
      reauthenticated = true;
    }
    if (!account.isDefault && (reauthenticated || health.refreshed)) {
      try {
        clearAccountUsageCache(account.label, env);
      } catch {
        onStatus(`${account.label}: could not clear its usage cache; the next probe may show stale data.`);
      }
    }
    const identity = account.isDefault
      ? readDefaultClaudeIdentity()
      : readAccountIdentity(account.provider, account.configDir);
    const duplicateOf = account.isDefault
      ? findDuplicateAccounts(identity, "claude-code", registered, "__default__")
      : findDuplicateAccounts(identity, account.provider, registered, account.label);
    const signedInAs = formatAccountIdentity(identity) || null;
    const planType = readCredentials(account)?.subscriptionType ?? null;
    onStatus(`${account.label} is signed in as ${signedInAs ?? "unknown"}${planType ? ` (${planType})` : ""}.`);
    if (duplicateOf.length > 0) {
      onStatus(`Warning: ${account.label} shares one subscription quota with ${duplicateOf.join(", ")}.`);
    }
    results.push({
      label: account.label,
      ok: true,
      reauthenticated,
      refreshed: health.refreshed,
      signedInAs,
      planType,
      duplicateOf,
    });
  }
  return results;
}
