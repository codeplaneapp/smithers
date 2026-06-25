import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { openSmithersBackend } from "./openSmithersBackend.js";
import { resolveSmithersBackendChoice } from "./resolveSmithersBackendChoice.js";

function sleep(ms) {
    return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

async function openSqliteStore(dbPath) {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(dbPath);
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        adapter: new SmithersDb(db),
        db,
        cleanup: () => {
            try {
                sqlite.close();
            }
            catch {
                // best-effort cleanup
            }
        },
    };
}

function assertReadStoreExists(choice, opts) {
    if (choice.backend === "sqlite") {
        if (!existsSync(choice.dbPath)) {
            throw new SmithersError("CLI_DB_NOT_FOUND", `No smithers.db found at ${choice.dbPath}. Run 'smithers up <workflow>' to start a run first.`);
        }
        return;
    }
    if (choice.backend === "pglite") {
        const cwd = resolve(opts.cwd ?? process.cwd());
        const dataDir = resolve(cwd, opts.pgliteDataDir ?? join(choice.workspaceRoot, ".smithers", "pg"));
        if (!existsSync(join(dataDir, "PG_VERSION"))) {
            throw new SmithersError("CLI_DB_NOT_FOUND", `No initialized PGlite store found at ${dataDir}. Run 'smithers up <workflow>' to start a run first.`);
        }
    }
}

async function assertRunsTableExists(db) {
    const descriptor = db;
    if (descriptor?.dialect === "postgres" && descriptor.connection) {
        const result = await descriptor.connection.query({
            text: "SELECT to_regclass($1) AS table_name",
            values: ["public._smithers_runs"],
        });
        if (!result.rows?.[0]?.table_name) {
            throw new SmithersError("CLI_DB_NOT_FOUND", "No Smithers run table found in the resolved backend. Run 'smithers up <workflow>' to start a run first.");
        }
    }
}

async function retryNotFound(fn, wait = {}) {
    const timeoutMs = Math.max(0, wait.timeoutMs ?? 0);
    const intervalMs = Math.max(1, wait.intervalMs ?? 100);
    const startedAt = Date.now();
    while (true) {
        try {
            return await fn();
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
 * Resolve the Smithers backend once, open exactly that store, and return the
 * low-level SmithersDb adapter used by CLI/server read paths.
 *
 * @param {import("./OpenSmithersStoreOptions.ts").OpenSmithersStoreOptions} [opts]
 * @returns {Promise<import("./OpenSmithersStoreResult.ts").OpenSmithersStoreResult>}
 */
export async function openSmithersStore(opts = {}) {
    const mode = opts.mode ?? "write";
    return retryNotFound(async () => {
        const choice = await resolveSmithersBackendChoice(opts);
        if (mode === "read") {
            assertReadStoreExists(choice, opts);
        }
        if (choice.backend === "sqlite") {
            const opened = await openSqliteStore(choice.dbPath);
            return {
                choice,
                adapter: opened.adapter,
                db: opened.db,
                dbPath: choice.dbPath,
                cleanup: opened.cleanup,
            };
        }
        const api = await openSmithersBackend({}, opts);
        try {
            if (mode === "read") {
                await assertRunsTableExists(api.db);
            }
            return {
                choice,
                adapter: new SmithersDb(api.db),
                db: api.db,
                cleanup: async () => {
                    await api.close?.();
                },
            };
        }
        catch (err) {
            await api.close?.();
            throw err;
        }
    }, opts.wait);
}
