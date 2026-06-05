import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountsRoot } from "@smithers-orchestrator/accounts";

/** @typedef {import("./UsageReport.ts").UsageReport} UsageReport */
/** @typedef {{ version: 1; entries: Record<string, { report: UsageReport }> }} UsageCacheFile */

/**
 * Path to the on-disk usage cache. Lives next to `accounts.json` under the
 * Smithers root so it honors `SMITHERS_HOME` in tests and CI.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function usageCachePath(env = process.env) {
    return join(accountsRoot(env), "usage-cache.json");
}

/**
 * Reads the usage cache, returning an empty cache when the file is missing or
 * malformed (a cold cache is the normal startup state, not an error).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UsageCacheFile}
 */
export function readUsageCache(env = process.env) {
    const path = usageCachePath(env);
    if (!existsSync(path)) return { version: 1, entries: {} };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
            return { version: 1, entries: parsed.entries };
        }
    } catch {
        // fall through to empty cache
    }
    return { version: 1, entries: {} };
}

/**
 * Writes the usage cache atomically with mode 0600.
 *
 * @param {UsageCacheFile} contents
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the path written
 */
export function writeUsageCache(contents, env = process.env) {
    const path = usageCachePath(env);
    mkdirSync(accountsRoot(env), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(contents, null, 2), { mode: 0o600 });
    // rename is atomic on the same filesystem
    renameSync(tmp, path);
    return path;
}
