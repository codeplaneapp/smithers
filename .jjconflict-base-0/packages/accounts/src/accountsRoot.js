import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns the user-level Smithers root directory (~/.smithers by default).
 * Honors `SMITHERS_HOME` for tests and CI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function accountsRoot(env = process.env) {
    if (env.SMITHERS_HOME) {
        return env.SMITHERS_HOME;
    }
    return join(env.HOME ?? homedir(), ".smithers");
}
