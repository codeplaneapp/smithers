import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersError } from "@smithers-orchestrator/errors";
import { findSmithersAnchorDir } from "smithers-orchestrator/findSmithersAnchorDir";
import { resolveSmithersBackendChoice } from "smithers-orchestrator/resolveSmithersBackendChoice";
/** @typedef {import("./FindDbWaitOptions.ts").FindDbWaitOptions} FindDbWaitOptions */

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
        // Stop at the filesystem root — never add /smithers.db as a candidate.
        if (dir === root) break;
        const candidate = resolve(dir, "smithers.db");
        if (existsSync(candidate)) {
            allCandidates.push(candidate);
        }
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
 * Enforce the fail-loud migration gate before any CLI read command opens the
 * legacy bun:sqlite store. Resolution and the SMITHERS_MIGRATION_REQUIRED check
 * are shared with the async backend factory (`openSmithersBackend`) so the CLI
 * read path and the gateway/server boot path honor the identical contract: a
 * legacy SQLite store holding run data is never silently read when the resolved
 * backend is pglite/postgres and no `migrated.json` marker exists. `--backend
 * sqlite` (SMITHERS_BACKEND / smithers.config.ts) pins the resolver back at the
 * SQLite store and suppresses the error.
 *
 * @param {string} [from]
 */
async function assertSmithersReadBackend(from) {
    await resolveSmithersBackendChoice({ cwd: from ?? process.cwd() });
}
/**
 * Find and open the nearest smithers.db.
 *
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<{ adapter: SmithersDb; dbPath: string; cleanup: () => void }>}
 */
export async function findAndOpenDb(from, opts) {
    await assertSmithersReadBackend(from);
    const dbPath = await waitForSmithersDb(from, opts);
    const { adapter, cleanup } = await openSmithersDb(dbPath);
    return { adapter, dbPath, cleanup };
}
