import { join } from "node:path";
import { accountsRoot } from "./accountsRoot.js";

/**
 * Default location for a per-account CLI config dir, e.g.
 * `~/.smithers/accounts/claude-work`.
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultConfigDir(label, env = process.env) {
    return join(accountsRoot(env), "accounts", label);
}
