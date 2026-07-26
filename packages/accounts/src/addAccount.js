import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { readAccounts } from "./readAccounts.js";
import { writeAccounts } from "./writeAccounts.js";
import { withAccountsLock } from "./withAccountsLock.js";
import { invalidateUsageCacheEntry } from "./invalidateUsageCacheEntry.js";
import { API_KEY_PROVIDERS, SUBSCRIPTION_PROVIDERS, VALID_PROVIDERS } from "./parseAccountsFile.js";

/** @typedef {import("./Account.ts").Account} Account */

/**
 * Adds (or replaces, if a same-label account exists) an account in the
 * registry. Validates the entry before persisting so a malformed call cannot
 * corrupt the file.
 *
 * @param {Account} account
 * @param {{ replace?: boolean; env?: NodeJS.ProcessEnv }} [options]
 * @returns {Account}
 */
export function addAccount(account, options = {}) {
  const env = options.env ?? process.env;
  if (!account.label || !account.label.trim()) {
    throw new SmithersError("ACCOUNT_INVALID", "account.label must be a non-empty string");
  }
  if (!VALID_PROVIDERS.has(account.provider)) {
    throw new SmithersError(
      "ACCOUNT_INVALID",
      `account.provider must be one of ${[...VALID_PROVIDERS].join(", ")}, got ${JSON.stringify(account.provider)}`,
    );
  }
  if (typeof account.configDir === "string" && typeof account.apiKey === "string") {
    throw new SmithersError(
      "ACCOUNT_INVALID",
      `${account.provider} account "${account.label}" must set configDir or apiKey, never both`,
    );
  }
  if (SUBSCRIPTION_PROVIDERS.has(account.provider) && (!account.configDir || !account.configDir.trim())) {
    throw new SmithersError("ACCOUNT_INVALID", `${account.provider} accounts require a non-empty configDir`);
  }
  if (API_KEY_PROVIDERS.has(account.provider) && typeof account.apiKey !== "string") {
    throw new SmithersError(
      "ACCOUNT_INVALID",
      `${account.provider} accounts require apiKey (may be empty string for env-var-only)`,
    );
  }
  // Read-modify-write must be serialized against concurrent mutations or a
  // second writer's atomic rename clobbers this entry (lost update). The lock
  // covers read → conflict-check → write so the base state we mutate is the
  // same one we persist.
  return withAccountsLock(env, () => {
    const existing = readAccounts(env);
    // Legacy rows this build can't parse ride through the rewrite untouched:
    // an unrelated add must not destroy the configDir/apiKey they point at.
    // They still own their label, so a collision is a real duplicate.
    const preserved = existing.unknownAccounts ?? [];
    const conflict = existing.accounts.findIndex((entry) => entry.label === account.label);
    const preservedConflict = preserved.findIndex((entry) => entry.label === account.label);
    if ((conflict >= 0 || preservedConflict >= 0) && !options.replace) {
      throw new SmithersError(
        "ACCOUNT_DUPLICATE_LABEL",
        `An account with label "${account.label}" already exists. Pass replace: true to overwrite, or use a different label.`,
      );
    }
    /** @type {Account} */
    const persisted = {
      label: account.label,
      provider: account.provider,
      addedAt: account.addedAt ?? existing.accounts[conflict]?.addedAt ?? new Date().toISOString(),
    };
    if (account.configDir) persisted.configDir = account.configDir;
    if (account.apiKey !== undefined) persisted.apiKey = account.apiKey;
    if (account.model) persisted.model = account.model;
    const next =
      conflict >= 0
        ? existing.accounts.map((entry, i) => (i === conflict ? persisted : entry))
        : [...existing.accounts, persisted];
    // `replace: true` on a legacy label supersedes it — the migration path.
    const nextUnknown = preserved.filter((entry) => entry.label !== account.label);
    writeAccounts({ version: 1, accounts: next, unknownAccounts: nextUnknown }, env);
    if (conflict >= 0 || preservedConflict >= 0) {
      invalidateUsageCacheEntry(account.label, env);
    }
    return persisted;
  });
}
