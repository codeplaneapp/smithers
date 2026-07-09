import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { readAccounts } from "./readAccounts.js";
import { writeAccounts } from "./writeAccounts.js";
import { withAccountsLock } from "./withAccountsLock.js";

/**
 * Removes an account by label. Also removes a preserved unknown-provider entry
 * with that label — since those now survive every rewrite, `agents remove` is
 * the supported way to clean up or migrate one. Throws if no account exists
 * with that label unless `silent: true`.
 *
 * @param {string} label
 * @param {{ silent?: boolean; env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean} true if an entry was removed
 */
export function removeAccount(label, options = {}) {
    const env = options.env ?? process.env;
    // Serialized read-modify-write so a concurrent addAccount cannot have its
    // entry dropped by this remove's whole-file rewrite (lost update).
    return withAccountsLock(env, () => {
        const existing = readAccounts(env);
        const preserved = existing.unknownAccounts ?? [];
        const nextAccounts = existing.accounts.filter((entry) => entry.label !== label);
        const nextUnknown = preserved.filter((entry) => entry.label !== label);
        const removed = nextAccounts.length !== existing.accounts.length
            || nextUnknown.length !== preserved.length;
        if (!removed) {
            if (options.silent) return false;
            throw new SmithersError("ACCOUNT_NOT_FOUND", `No account with label "${label}" is registered.`);
        }
        writeAccounts({ version: 1, accounts: nextAccounts, unknownAccounts: nextUnknown }, env);
        return true;
    });
}
