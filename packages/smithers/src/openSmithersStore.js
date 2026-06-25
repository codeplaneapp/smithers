import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SmithersDb } from "../../db/src/adapter.js";
import { ensureSmithersTables } from "../../db/src/ensure.js";
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

function assertRunsTableExists(choice) {
    if (choice.backend === "pglite" && !choice.pglite?.hasRunsTable) {
        throw new SmithersError("CLI_DB_NOT_FOUND", "No Smithers run table found in the resolved backend. Run 'smithers up <workflow>' to start a run first.");
    }
    if (choice.backend === "postgres" && !choice.postgres?.hasRunsTable) {
        throw new SmithersError("CLI_DB_NOT_FOUND", "No Smithers run table found in the resolved backend. Run 'smithers up <workflow>' to start a run first.");
    }
}

async function openPostgresStore(choice, opts) {
    const env = opts.env ?? process.env;
    const pgModule = await import("pg");
    const pg = pgModule.default ?? pgModule;
    pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
    /** @type {Array<() => Promise<void>>} */
    const teardown = [];
    let connectionString = opts.connectionString ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL;
    if (choice.backend === "pglite") {
        const cwd = resolve(opts.cwd ?? process.cwd());
        const dataDir = resolve(cwd, opts.pgliteDataDir ?? join(choice.workspaceRoot, ".smithers", "pg"));
        const { PGlite } = await import("@electric-sql/pglite");
        const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
        const pglite = await PGlite.create(dataDir);
        const port = await findFreePgPort();
        const server = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port, maxConnections: 5 });
        await server.start();
        teardown.push(async () => {
            await server.stop().catch(() => {});
            await pglite.close().catch(() => {});
        });
        connectionString = `postgres://postgres@127.0.0.1:${port}/postgres`;
    }
    const client = new pg.Client(connectionString ? { connectionString } : opts.connection);
    try {
        await client.connect();
        teardown.push(async () => {
            await client.end().catch(() => {});
        });
        const descriptor = { dialect: "postgres", connection: client, schema: {} };
        return {
            adapter: new SmithersDb(descriptor),
            db: descriptor,
            cleanup: async () => {
                for (const fn of teardown.reverse()) {
                    await fn();
                }
            },
        };
    }
    catch (error) {
        for (const fn of teardown.reverse()) {
            await fn().catch(() => {});
        }
        throw error;
    }
}

async function findFreePgPort() {
    const net = await import("node:net");
    return new Promise((resolveFn, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            srv.close(() => {
                if (address && typeof address === "object") resolveFn(address.port);
                else reject(new Error("Could not allocate a local PGlite socket port"));
            });
        });
    });
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
        if (mode === "read") {
            assertRunsTableExists(choice);
            const opened = await openPostgresStore(choice, opts);
            return {
                choice,
                adapter: opened.adapter,
                db: opened.db,
                cleanup: opened.cleanup,
            };
        }
        const api = await openSmithersBackend({}, opts);
        try {
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
