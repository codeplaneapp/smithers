import { listAccounts } from "./listAccounts.js";

/**
 * Looks up an account by label. Returns undefined if not found (callers
 * decide whether absence is an error).
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account | undefined}
 */
export function getAccount(label, env = process.env) {
    return listAccounts(env).find((account) => account.label === label);
}
