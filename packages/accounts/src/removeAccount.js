import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { readAccounts } from "./readAccounts.js";
import { writeAccounts } from "./writeAccounts.js";

/**
 * Removes an account by label. Throws if no account exists with that label
 * unless `silent: true`.
 *
 * @param {string} label
 * @param {{ silent?: boolean; env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean} true if an entry was removed
 */
export function removeAccount(label, options = {}) {
    const env = options.env ?? process.env;
    const existing = readAccounts(env);
    const next = existing.accounts.filter((entry) => entry.label !== label);
    if (next.length === existing.accounts.length) {
        if (options.silent) return false;
        throw new SmithersError("ACCOUNT_NOT_FOUND", `No account with label "${label}" is registered.`);
    }
    writeAccounts({ version: 1, accounts: next }, env);
    return true;
}
