import { resolve, dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersError } from "@smithers-orchestrator/errors";
/** @typedef {import("./FindDbWaitOptions.ts").FindDbWaitOptions} FindDbWaitOptions */

/**
 * Walk upward from `from` and return the nearest directory that contains a
 * `.smithers/` subdirectory, or `undefined` if none is found before the
 * filesystem root.
 *
 * Directories at or above $HOME are excluded: a `~/.smithers` global pack
 * must not be treated as a project anchor, so the DB would incorrectly land
 * in the user's home directory.
 *
 * @param {string} from
 * @returns {string | undefined}
 */
function findSmithersAnchorDir(from) {
    let dir = resolve(from);
    const fsRoot = resolve("/");
    const home = process.env.HOME ? resolve(process.env.HOME) : undefined;
    while (true) {
        // Stop before reaching HOME — anchors must be proper project directories
        // below the user's home directory.
        if (home && (dir === home || dir.length < home.length)) {
            return undefined;
        }
        const candidate = join(dir, ".smithers");
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return dir;
        }
        if (dir === fsRoot) {
            return undefined;
        }
        dir = dirname(dir);
    }
}

/**
 * Walk from `from` (default: cwd) upward looking for smithers.db.
 *
 * Resolution order:
 *   1. The directory containing the nearest `.smithers/` anchor (walking up).
 *      If a `smithers.db` lives there, return it — even when a stray
 *      `smithers.db` also exists closer to `from`.
 *   2. Any `smithers.db` encountered while walking upward (original behaviour,
 *      kept as fallback for projects that have no `.smithers/` pack yet).
 *
 * If more than one `smithers.db` is found along the walk, a warning is emitted
 * to stderr so the user knows which one was chosen.
 *
 * Returns the absolute path to the database file.
 *
 * @param {string} [from]
 * @returns {string}
 */
export function findSmithersDb(from) {
    const startDir = resolve(from ?? process.cwd());
    const root = resolve("/");

    // Collect every smithers.db along the upward walk so we can warn about
    // multiple candidates and enforce the anchor-preference rule.
    /** @type {string[]} */
    const allCandidates = [];
    let dir = startDir;
    while (true) {
        const candidate = resolve(dir, "smithers.db");
        if (existsSync(candidate)) {
            allCandidates.push(candidate);
        }
        if (dir === root) break;
        dir = dirname(dir);
    }

    if (allCandidates.length === 0) {
        throw new SmithersError("CLI_DB_NOT_FOUND", "No smithers.db found. Run this command from a directory containing a smithers.db, or use 'smithers up <workflow>' to start a run first.");
    }

    // Prefer the smithers.db that sits at the project anchor (nearest .smithers/).
    const anchorDir = findSmithersAnchorDir(startDir);
    const anchorDb = anchorDir ? resolve(anchorDir, "smithers.db") : undefined;
    // If an anchor directory was found but its DB hasn't been created yet, do NOT
    // fall back to a stray smithers.db from a parent or sibling directory — that
    // would silently cross the project boundary.  Instead throw CLI_DB_NOT_FOUND so
    // the caller (or waitForSmithersDb) can retry until the anchor DB appears.
    if (anchorDb && !existsSync(anchorDb)) {
        throw new SmithersError("CLI_DB_NOT_FOUND", `No smithers.db found at project anchor ${anchorDir}. Run 'smithers up <workflow>' to start a run first.`);
    }
    const chosen = anchorDb ?? allCandidates[0];

    if (allCandidates.length > 1) {
        const others = allCandidates.filter((p) => p !== chosen);
        process.stderr.write(
            `[smithers] Warning: multiple smithers.db files found along the directory tree.\n` +
            `  Using: ${chosen}\n` +
            others.map((p) => `  Ignored: ${p}`).join("\n") + "\n",
        );
    }

    return chosen;
}
/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<string>}
 */
export async function waitForSmithersDb(from, opts = {}) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
    const intervalMs = Math.max(1, opts.intervalMs ?? 100);
    const startedAt = Date.now();
    while (true) {
        try {
            return findSmithersDb(from);
        }
        catch (err) {
            if (!(err instanceof SmithersError) || err.code !== "CLI_DB_NOT_FOUND") {
                throw err;
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= timeoutMs) {
                throw err;
            }
            await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
        }
    }
}
/**
 * Open a smithers.db file and return a SmithersDb adapter with cleanup function.
 *
 * @param {string} dbPath
 * @returns {Promise<{ adapter: SmithersDb; cleanup: () => void }>}
 */
export async function openSmithersDb(dbPath) {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        adapter: new SmithersDb(db),
        cleanup: () => {
            try {
                sqlite.close();
            }
            catch { }
        },
    };
}
/**
 * Find and open the nearest smithers.db.
 *
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<{ adapter: SmithersDb; dbPath: string; cleanup: () => void }>}
 */
export async function findAndOpenDb(from, opts) {
    const dbPath = await waitForSmithersDb(from, opts);
    const { adapter, cleanup } = await openSmithersDb(dbPath);
    return { adapter, dbPath, cleanup };
}
