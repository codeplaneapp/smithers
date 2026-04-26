import { existsSync, readFileSync } from "node:fs";
import { accountsFilePath } from "./accountsFilePath.js";
import { parseAccountsFile } from "./parseAccountsFile.js";

/**
 * Reads ~/.smithers/accounts.json. Returns an empty registry if the file does
 * not exist (a fresh install with no accounts is the normal startup state, not
 * an error).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./AccountsFile.ts").AccountsFile}
 */
export function readAccounts(env = process.env) {
    const path = accountsFilePath(env);
    if (!existsSync(path)) {
        return { version: 1, accounts: [] };
    }
    const raw = readFileSync(path, "utf8");
    return parseAccountsFile(raw);
}
