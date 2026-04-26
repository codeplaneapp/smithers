import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { accountsFilePath } from "./accountsFilePath.js";

/**
 * Atomically writes the accounts registry to ~/.smithers/accounts.json. The
 * file is mode 0600 because it may contain raw API keys.
 *
 * @param {import("./AccountsFile.ts").AccountsFile} contents
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the file path that was written
 */
export function writeAccounts(contents, env = process.env) {
    const path = accountsFilePath(env);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    const serialized = `${JSON.stringify(contents, null, 2)}\n`;
    writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return path;
}
