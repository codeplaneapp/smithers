import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { POSTGRES, quoteIdentifier, translateDdl } from "@smithers-orchestrator/db/dialect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createSmithersPostgres } from "./create.js";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";

const DEFAULT_BATCH_SIZE = 250;
const MIGRATION_MARKER_NAME = "migrated.json";

/**
 * @typedef {"pglite" | "postgres"} MigrateSmithersTarget
 * @typedef {{
 *   cwd?: string;
 *   dbPath?: string;
 *   to?: MigrateSmithersTarget;
 *   url?: string;
 *   env?: Record<string, string | undefined>;
 *   pgliteDataDir?: string;
 *   keepSqlite?: boolean;
 *   batchSize?: number;
 *   onProgress?: (event: MigrationProgressEvent) => void | Promise<void>;
 * }} MigrateSmithersStoreOptions
 * @typedef {{
 *   type: "table-start" | "table-copied" | "done";
 *   table?: string;
 *   copiedRows?: number;
 *   sourceRows?: number;
 *   targetRows?: number;
 *   tableCount?: number;
 *   durationMs?: number;
 * }} MigrationProgressEvent
 * @typedef {{
 *   table: string;
 *   sourceRows: number;
 *   targetRows: number;
 *   durationMs: number;
 * }} MigrationTableResult
 * @typedef {{
 *   backend: MigrateSmithersTarget;
 *   dbPath: string;
 *   markerPath: string;
 *   target: { backend: MigrateSmithersTarget; dataDir?: string; url?: string };
 *   runCount: number;
 *   schemaVersion: string;
 *   durationMs: number;
 *   tables: MigrationTableResult[];
 *   sqliteRemoved: boolean;
 * }} MigrateSmithersStoreResult
 */

/**
 * @param {unknown} value
 * @returns {MigrateSmithersTarget}
 */
function normalizeTarget(value) {
    if (value === undefined || value === null || value === "") {
        return "pglite";
    }
    const target = String(value).toLowerCase();
    if (target === "pglite" || target === "postgres") {
        return target;
    }
    throw new SmithersError("INVALID_INPUT", `Invalid migration target: ${String(value)}. Expected pglite or postgres.`, {
        target: value,
    });
}

/**
 * @param {string} dbPath
 * @param {string} workspaceRoot
 * @returns {string}
 */
function markerPathFor(dbPath, workspaceRoot) {
    return join(workspaceRoot, ".smithers", MIGRATION_MARKER_NAME);
}

/**
 * @param {string} identifier
 * @returns {string}
 */
function sqliteQuote(identifier) {
    return `"${String(identifier).replaceAll(`"`, `""`)}"`;
}

/**
 * @param {Database} sqlite
 * @param {string} table
 * @returns {boolean}
 */
function sqliteTableExists(sqlite, table) {
    return Boolean(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * @param {Database} sqlite
 * @param {string} table
 * @returns {number}
 */
function countSqliteRows(sqlite, table) {
    const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${sqliteQuote(table)}`).get();
    return Number(row?.count ?? 0);
}

/**
 * @param {Database} sqlite
 * @returns {string}
 */
function sqliteSchemaVersion(sqlite) {
    if (!sqliteTableExists(sqlite, "_smithers_schema_migrations")) {
        return "0000";
    }
    const row = sqlite
        .query("SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1")
        .get();
    const id = typeof row?.id === "string" ? row.id : "0000";
    return id.match(/^\d+/)?.[0] ?? id;
}

/**
 * @param {Database} sqlite
 * @returns {Array<{ name: string; sql: string }>}
 */
function sourceTables(sqlite) {
    return sqlite
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .filter((row) => typeof row?.name === "string" && typeof row?.sql === "string")
        .map((row) => ({ name: row.name, sql: row.sql }));
}

/**
 * @param {Database} sqlite
 * @returns {Array<{ name: string; sql: string }>}
 */
function sourceIndexes(sqlite) {
    return sqlite
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
        .all()
        .filter((row) => typeof row?.name === "string" && typeof row?.sql === "string")
        .map((row) => ({ name: row.name, sql: row.sql }));
}

/**
 * @param {Database} sqlite
 * @param {string} table
 * @returns {string[]}
 */
function sourceColumns(sqlite, table) {
    return sqlite
        .query(`PRAGMA table_info(${sqliteQuote(table)})`)
        .all()
        .map((row) => row?.name)
        .filter((name) => typeof name === "string");
}

/**
 * @param {Database} sqlite
 * @param {string} table
 * @returns {boolean}
 */
function sourceHasBlobColumn(sqlite, table) {
    return sqlite
        .query(`PRAGMA table_info(${sqliteQuote(table)})`)
        .all()
        .some((row) => typeof row?.type === "string" && /\bBLOB\b/i.test(row.type));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function encodePgValue(value) {
    if (value === undefined) {
        return null;
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value);
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return value;
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {string} table
 * @returns {Promise<boolean>}
 */
async function pgTableExists(pgConn, table) {
    const result = await pgConn.query({
        text: "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1",
        values: [table],
    });
    return Boolean(/** @type {{ rows?: readonly Record<string, unknown>[] }} */ (result).rows?.[0]);
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {string} table
 * @returns {Promise<number>}
 */
async function countPgRows(pgConn, table) {
    const result = await pgConn.query({ text: `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}` });
    return Number(/** @type {{ rows?: readonly Record<string, unknown>[] }} */ (result).rows?.[0]?.count ?? 0);
}

/**
 * @param {string} ddl
 * @returns {string}
 */
function translatedCreateTable(ddl) {
    return translateDdl(POSTGRES, ddl);
}

/**
 * @param {string} ddl
 * @returns {string}
 */
function translatedCreateIndex(ddl) {
    const withIfNotExists = /\bIF\s+NOT\s+EXISTS\b/i.test(ddl)
        ? ddl
        : ddl.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_match, unique = "") => `CREATE ${unique}INDEX IF NOT EXISTS `);
    return translateDdl(POSTGRES, withIfNotExists);
}

/**
 * @param {string} table
 * @returns {number}
 */
function tablePriority(table) {
    if (table === "_smithers_schema_migrations") return 0;
    if (table === "_smithers_runs") return 1;
    if (table === "input") return 2;
    if (table.startsWith("_smithers_")) return 3;
    return 4;
}

/**
 * @param {Array<{ name: string; sql: string }>} tables
 * @returns {Array<{ name: string; sql: string }>}
 */
function orderedTables(tables) {
    return [...tables].sort((a, b) => {
        const priority = tablePriority(a.name) - tablePriority(b.name);
        return priority === 0 ? a.name.localeCompare(b.name) : priority;
    });
}

/**
 * @param {string} sql
 * @returns {string[]}
 */
function autoincrementColumns(sql) {
    const match = sql.match(/["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i);
    return match?.[1] ? [match[1]] : [];
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {string} table
 * @param {string[]} columns
 */
async function resetSequences(pgConn, table, columns) {
    for (const column of columns) {
        const seqResult = await pgConn.query({
            text: "SELECT pg_get_serial_sequence($1, $2) AS seq",
            values: [table, column],
        });
        const seq = /** @type {{ rows?: readonly Record<string, unknown>[] }} */ (seqResult).rows?.[0]?.seq;
        if (typeof seq !== "string" || seq.length === 0) {
            continue;
        }
        await pgConn.query({
            text: `SELECT setval($1::regclass, COALESCE((SELECT MAX(${quoteIdentifier(column)}) FROM ${quoteIdentifier(table)}), 1), (SELECT COUNT(*) > 0 FROM ${quoteIdentifier(table)}))`,
            values: [seq],
        });
    }
}

/**
 * @param {MigrationProgressEvent} event
 * @param {MigrateSmithersStoreOptions} opts
 */
async function emitProgress(event, opts) {
    await opts.onProgress?.(event);
}

/**
 * @param {"info" | "error"} level
 * @param {string} message
 * @param {Record<string, unknown>} attrs
 * @param {string} span
 */
async function emitMigrationLog(level, message, attrs, span) {
    const log = level === "error" ? Effect.logError(message) : Effect.logInfo(message);
    await Effect.runPromise(log.pipe(Effect.annotateLogs(attrs), Effect.withLogSpan(span))).catch(() => {});
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {Array<{ name: string; sql: string }>} tables
 */
async function prepareTargetTables(pgConn, tables) {
    for (const table of tables) {
        const exists = await pgTableExists(pgConn, table.name);
        if (!exists) {
            await pgConn.query({ text: translatedCreateTable(table.sql) });
            continue;
        }
        if (table.name === "_smithers_schema_migrations") {
            continue;
        }
        const rowCount = await countPgRows(pgConn, table.name);
        if (rowCount > 0) {
            throw new SmithersError("DB_WRITE_FAILED", `Target table ${table.name} already has ${rowCount} rows; refusing to merge a one-shot Smithers migration into a non-empty target.`, {
                table: table.name,
                rowCount,
            });
        }
        if (table.name === "input" || !table.name.startsWith("_smithers_")) {
            await pgConn.query({ text: `DROP TABLE ${quoteIdentifier(table.name)}` });
            await pgConn.query({ text: translatedCreateTable(table.sql) });
        }
    }
}

/**
 * @param {Database} sqlite
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {{ name: string; sql: string }} table
 * @param {number} batchSize
 * @param {MigrateSmithersStoreOptions} opts
 * @returns {Promise<MigrationTableResult>}
 */
async function copyTable(sqlite, pgConn, table, batchSize, opts) {
    const startedAt = Date.now();
    const columns = sourceColumns(sqlite, table.name);
    const sourceRows = countSqliteRows(sqlite, table.name);
    await emitProgress({ type: "table-start", table: table.name, sourceRows }, opts);
    await emitMigrationLog("info", "smithers.migration.table.start", {
        table: table.name,
        sourceRows,
    }, "smithers:migrate:table");
    if (columns.length === 0) {
        const targetRows = await countPgRows(pgConn, table.name);
        return {
            table: table.name,
            sourceRows,
            targetRows,
            durationMs: Date.now() - startedAt,
        };
    }
    const columnSql = columns.map(quoteIdentifier).join(", ");
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const insertSql = `INSERT INTO ${quoteIdentifier(table.name)} (${columnSql}) VALUES (${placeholders})`;
    const selectSql = `SELECT ${columns.map(sqliteQuote).join(", ")} FROM ${sqliteQuote(table.name)} LIMIT ? OFFSET ?`;
    const select = sqlite.query(selectSql);
    const effectiveBatchSize = sourceHasBlobColumn(sqlite, table.name) ? 1 : batchSize;
    await pgConn.query({ text: "BEGIN" });
    try {
        if (table.name === "_smithers_schema_migrations") {
            await pgConn.query({ text: `DELETE FROM ${quoteIdentifier(table.name)}` });
        }
        let offset = 0;
        let copiedRows = 0;
        while (true) {
            const rows = select.all(effectiveBatchSize, offset);
            if (rows.length === 0) {
                break;
            }
            for (const row of rows) {
                await pgConn.query({
                    text: insertSql,
                    values: columns.map((column) => encodePgValue(row[column])),
                });
            }
            copiedRows += rows.length;
            offset += rows.length;
        }
        await resetSequences(pgConn, table.name, autoincrementColumns(table.sql));
        await pgConn.query({ text: "COMMIT" });
        const targetRows = await countPgRows(pgConn, table.name);
        const durationMs = Date.now() - startedAt;
        await emitProgress({
            type: "table-copied",
            table: table.name,
            copiedRows,
            sourceRows,
            targetRows,
            durationMs,
        }, opts);
        await emitMigrationLog("info", "smithers.migration.table.copied", {
            table: table.name,
            copiedRows,
            sourceRows,
            targetRows,
            durationMs,
        }, "smithers:migrate:table");
        return { table: table.name, sourceRows, targetRows, durationMs };
    }
    catch (error) {
        try {
            await pgConn.query({ text: "ROLLBACK" });
        }
        catch {
            // Preserve the original copy failure.
        }
        await emitMigrationLog("error", "smithers.migration.table.failed", {
            table: table.name,
            sourceRows,
            durationMs: Date.now() - startedAt,
            error: error?.message ?? String(error),
        }, "smithers:migrate:table");
        throw error;
    }
}

/**
 * @param {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} pgConn
 * @param {Array<{ name: string; sql: string }>} indexes
 */
async function createIndexes(pgConn, indexes) {
    for (const index of indexes) {
        await pgConn.query({ text: translatedCreateIndex(index.sql) });
    }
}

/**
 * @param {string} dbPath
 * @returns {{ sizeBytes: number | null; mtimeMs: number | null }}
 */
function sourceFileStats(dbPath) {
    try {
        const stats = statSync(dbPath);
        return { sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
    }
    catch {
        return { sizeBytes: null, mtimeMs: null };
    }
}

/**
 * @param {MigrateSmithersStoreResult} result
 * @param {{ sizeBytes: number | null; mtimeMs: number | null }} sourceStats
 */
function writeMigrationMarker(result, sourceStats) {
    mkdirSync(dirname(result.markerPath), { recursive: true });
    const marker = {
        migratedAt: new Date().toISOString(),
        source: {
            dbPath: result.dbPath,
            sizeBytes: sourceStats.sizeBytes,
            mtimeMs: sourceStats.mtimeMs,
            runCount: result.runCount,
            schemaVersion: result.schemaVersion,
        },
        target: result.target,
        durationMs: result.durationMs,
        tables: result.tables.map((table) => ({
            table: table.table,
            rows: table.sourceRows,
        })),
    };
    writeFileSync(result.markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

/**
 * @param {string} dbPath
 */
function removeSqliteFiles(dbPath) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        rmSync(path, { force: true });
    }
}

/**
 * One-shot copy from the legacy bun:sqlite Smithers store to PGlite/Postgres.
 *
 * @param {MigrateSmithersStoreOptions} [opts]
 * @returns {Promise<MigrateSmithersStoreResult>}
 */
export async function migrateSmithersStore(opts = {}) {
    const startedAt = Date.now();
    const cwd = resolve(opts.cwd ?? process.cwd());
    const env = opts.env ?? process.env;
    const workspaceRoot = findSmithersAnchorDir(cwd) ?? cwd;
    const dbPath = resolve(cwd, opts.dbPath ?? join(workspaceRoot, "smithers.db"));
    if (!existsSync(dbPath)) {
        throw new SmithersError("CLI_DB_NOT_FOUND", `No legacy SQLite store found at ${dbPath}.`, {
            dbPath,
        });
    }
    const target = normalizeTarget(opts.to);
    const markerPath = markerPathFor(dbPath, workspaceRoot);
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
    const keepSqlite = opts.keepSqlite ?? true;
    const sourceStats = sourceFileStats(dbPath);
    /** @type {Database | undefined} */
    let sqlite;
    /** @type {(import("./CreateSmithersApi.ts").CreateSmithersApi<Record<string, import("zod").ZodObject<any>>> & { close?: () => Promise<void> }) | undefined} */
    let targetApi;
    try {
        sqlite = new Database(dbPath, { readonly: true });
        sqlite.exec("BEGIN");
        const runCount = sqliteTableExists(sqlite, "_smithers_runs") ? countSqliteRows(sqlite, "_smithers_runs") : 0;
        const schemaVersion = sqliteSchemaVersion(sqlite);
        const tables = orderedTables(sourceTables(sqlite));
        const indexes = sourceIndexes(sqlite);
        await emitMigrationLog("info", "smithers.migration.started", {
            dbPath,
            target,
            tableCount: tables.length,
            runCount,
            schemaVersion,
        }, "smithers:migrate");
        if (target === "postgres") {
            const connectionString = opts.url ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL;
            if (!connectionString) {
                throw new SmithersError("INVALID_INPUT", "smithers migrate --to postgres requires --url, SMITHERS_POSTGRES_URL, or DATABASE_URL.", {
                    target,
                });
            }
            targetApi = await createSmithersPostgres({}, {
                provider: "postgres",
                connectionString,
            });
        }
        else {
            const dataDir = resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg"));
            mkdirSync(dirname(dataDir), { recursive: true });
            targetApi = await createSmithersPostgres({}, {
                provider: "pglite",
                dataDir,
            });
        }
        const pgConn = /** @type {{ query: (config: { text: string; values?: readonly unknown[] }) => Promise<{ rows?: readonly Record<string, unknown>[] } | unknown> }} */ (targetApi.db.connection);
        await prepareTargetTables(pgConn, tables);
        /** @type {MigrationTableResult[]} */
        const tableResults = [];
        for (const table of tables) {
            tableResults.push(await copyTable(sqlite, pgConn, table, batchSize, opts));
        }
        await createIndexes(pgConn, indexes);
        for (const table of tableResults) {
            if (table.sourceRows !== table.targetRows) {
                throw new SmithersError("DB_WRITE_FAILED", `Smithers migration count mismatch for ${table.table}: source=${table.sourceRows}, target=${table.targetRows}.`, {
                    table: table.table,
                    sourceRows: table.sourceRows,
                    targetRows: table.targetRows,
                });
            }
        }
        const durationMs = Date.now() - startedAt;
        const result = {
            backend: target,
            dbPath,
            markerPath,
            target: target === "postgres"
                ? { backend: target, url: (opts.url ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL) ? "set" : undefined }
                : { backend: target, dataDir: resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg")) },
            runCount,
            schemaVersion,
            durationMs,
            tables: tableResults,
            sqliteRemoved: false,
        };
        writeMigrationMarker(result, sourceStats);
        if (!keepSqlite) {
            sqlite.close();
            sqlite = undefined;
            removeSqliteFiles(dbPath);
            result.sqliteRemoved = true;
        }
        await emitProgress({
            type: "done",
            tableCount: tableResults.length,
            copiedRows: tableResults.reduce((sum, table) => sum + table.sourceRows, 0),
            durationMs,
        }, opts);
        await emitMigrationLog("info", "smithers.migration.completed", {
            dbPath,
            target,
            markerPath,
            tableCount: tableResults.length,
            rowCount: tableResults.reduce((sum, table) => sum + table.sourceRows, 0),
            durationMs,
            sqliteRemoved: result.sqliteRemoved,
        }, "smithers:migrate");
        return result;
    }
    catch (error) {
        await emitMigrationLog("error", "smithers.migration.failed", {
            dbPath,
            target,
            durationMs: Date.now() - startedAt,
            error: error?.message ?? String(error),
        }, "smithers:migrate");
        throw error;
    }
    finally {
        try {
            sqlite?.exec("ROLLBACK");
        }
        catch {
            // Closing the read-only connection is enough if no transaction is open.
        }
        try {
            sqlite?.close();
        }
        catch {
            // Best-effort read-only source cleanup.
        }
        await targetApi?.close?.();
    }
}
