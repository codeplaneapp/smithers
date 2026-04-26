import { join } from "node:path";
import { accountsRoot } from "./accountsRoot.js";

/**
 * Path to the JSON registry that lists all accounts.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function accountsFilePath(env = process.env) {
    return join(accountsRoot(env), "accounts.json");
}
