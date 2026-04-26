import { readAccounts } from "./readAccounts.js";

/**
 * Returns the array of registered accounts, in registration order.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./Account.ts").Account[]}
 */
export function listAccounts(env = process.env) {
    return readAccounts(env).accounts;
}
