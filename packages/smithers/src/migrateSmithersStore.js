import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { POSTGRES, quoteIdentifier, translateDdl } from "@smithers-orchestrator/db/dialect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { createSmithersPostgres } from "./create.js";
import { findSmithersAnchorDir } from "./findSmithersAnchorDir.js";

const DEFAULT_BATCH_SIZE = 250;
const MIGRATION_MARKER_NAME = "migrated.json";

/**
 * @typedef {"sqlite" | "pglite" | "postgres"} MigrateSmithersBackend
 * @typedef {{
 *   cwd?: string;
 *   dbPath?: string;
 *   from?: MigrateSmithersBackend;
 *   to?: MigrateSmithersBackend;
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
 *   backend: MigrateSmithersBackend;
 *   source: { backend: MigrateSmithersBackend; dbPath?: string; dataDir?: string; url?: string };
 *   dbPath: string;
 *   markerPath: string;
 *   target: { backend: MigrateSmithersBackend; dbPath?: string; dataDir?: string; url?: string };
 *   runCount: number;
 *   schemaVersion: string;
 *   durationMs: number;
 *   tables: MigrationTableResult[];
 *   sqliteRemoved: boolean;
 * }} MigrateSmithersStoreResult
 */

/**
 * @param {unknown} value
 * @returns {MigrateSmithersBackend}
 */
function normalizeBackend(value, fallback = "sqlite") {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const target = String(value).toLowerCase();
    if (target === "sqlite" || target === "pglite" || target === "postgres") {
        return target;
    }
    throw new SmithersError("INVALID_INPUT", `Invalid migration backend: ${String(value)}. Expected sqlite, pglite, or postgres.`, {
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
            ...result.source,
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
 * @param {MigrateSmithersStoreResult} result
 */
function writeBackendMarker(result) {
    const markerPath = join(dirname(result.markerPath), "backend.json");
    writeFileSync(markerPath, `${JSON.stringify({
        backend: result.backend,
        migratedAt: new Date().toISOString(),
        source: result.source,
        target: result.target,
    }, null, 2)}\n`, "utf8");
}

/**
 * @param {MigrateSmithersBackend} from
 * @param {MigrateSmithersBackend} to
 * @returns {string}
 */
function agentFallbackText(from, to) {
    return `\n\nRetry deterministic migration:\n  smithers migrate --from ${from} --to ${to}\n\nIf deterministic migration still fails, inspect the source and target stores for schema/data violations. Agent-assisted repair is tracked as a follow-up and is not available in this build.`;
}

/**
 * @param {unknown} error
 * @param {MigrateSmithersBackend} from
 * @param {MigrateSmithersBackend} to
 * @returns {unknown}
 */
function withAgentFallback(error, from, to) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Agent-assisted repair is tracked as a follow-up")) {
        return error;
    }
    if (error instanceof SmithersError) {
        return new SmithersError(error.code, `${message}${agentFallbackText(from, to)}`, error.details, { cause: error });
    }
    return new SmithersError("DB_WRITE_FAILED", `${message}${agentFallbackText(from, to)}`, {}, { cause: error });
}

// bun:sqlite surfaces a corrupt, encrypted, or non-SQLite source file with one
// of these substrings (case-insensitive). Detecting them lets us replace the
// raw, unactionable engine text with guidance the operator can follow.
const CORRUPT_SQLITE_MARKERS = ["malformed", "not a database", "file is encrypted", "disk image is malformed"];
const UNOPENABLE_SQLITE_MARKERS = ["unable to open database file"];

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isCorruptSqliteError(error) {
    const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
    return CORRUPT_SQLITE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnopenableSqliteError(error) {
    const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
    return UNOPENABLE_SQLITE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Open the legacy SQLite source and read its schema-level metadata. A corrupt,
 * encrypted, or non-SQLite file fails here (open, BEGIN, or the first query);
 * we wrap that into an actionable SmithersError so the CLI maps it to a clean
 * exit code instead of leaking the raw bun:sqlite text. The source is opened
 * read-only and nothing has been written to the target yet, so no partial
 * output can exist when this throws.
 *
 * @param {string} dbPath
 * @returns {{ sqlite: Database; runCount: number; schemaVersion: string; tables: Array<{ name: string; sql: string }>; indexes: Array<{ name: string; sql: string }> }}
 */
function openSourceStore(dbPath) {
    /** @type {Database | undefined} */
    let sqlite;
    try {
        sqlite = new Database(dbPath, { readonly: true });
        sqlite.exec("BEGIN");
        const runCount = sqliteTableExists(sqlite, "_smithers_runs") ? countSqliteRows(sqlite, "_smithers_runs") : 0;
        const schemaVersion = sqliteSchemaVersion(sqlite);
        const tables = orderedTables(sourceTables(sqlite));
        const indexes = sourceIndexes(sqlite);
        return { sqlite, runCount, schemaVersion, tables, indexes };
    }
    catch (error) {
        try {
            sqlite?.exec("ROLLBACK");
        }
        catch {
            // No open transaction to roll back; closing the handle is enough.
        }
        try {
            sqlite?.close();
        }
        catch {
            // Best-effort read-only source cleanup.
        }
        if (isCorruptSqliteError(error)) {
            const original = error instanceof Error ? error.message : String(error);
            throw new SmithersError("DB_QUERY_FAILED", `The legacy SQLite store at ${dbPath} appears to be corrupted (${original}). Smithers cannot migrate a corrupt store. Verify with: sqlite3 ${dbPath} 'PRAGMA integrity_check'. If it reports corruption, restore from a backup or start fresh; the original file was left untouched.`, { dbPath }, { cause: error });
        }
        if (isUnopenableSqliteError(error)) {
            const original = error instanceof Error ? error.message : String(error);
            throw new SmithersError("DB_QUERY_FAILED", `Could not open the legacy SQLite store at ${dbPath} (${original}). It may be locked by another process, have unreadable permissions, or be missing its -wal/-shm sidecar files (copy smithers.db together with smithers.db-wal and smithers.db-shm). The original file was left untouched.`, { dbPath }, { cause: error });
        }
        throw error;
    }
}

/**
 * @param {string} dbPath
 */
function removeSqliteFiles(dbPath) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        rmSync(path, { force: true });
    }
}

async function pgTables(pgConn) {
    const result = await pgConn.query({
        text: "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
    });
    return result.rows.map((row) => row.table_name).filter((name) => typeof name === "string");
}

async function pgColumns(pgConn, table) {
    const result = await pgConn.query({
        text: "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
        values: [table],
    });
    return result.rows.map((row) => ({
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable !== "NO",
    })).filter((column) => typeof column.name === "string");
}

function sqliteTypeForPg(dataType) {
    const type = String(dataType ?? "").toLowerCase();
    if (type.includes("int") || type === "boolean") return "INTEGER";
    if (type.includes("double") || type.includes("numeric") || type.includes("real")) return "REAL";
    if (type.includes("bytea")) return "BLOB";
    return "TEXT";
}

async function pgSchemaVersion(pgConn) {
    if (!(await pgTableExists(pgConn, "_smithers_schema_migrations"))) return "0000";
    const result = await pgConn.query({
        text: "SELECT id FROM _smithers_schema_migrations ORDER BY id DESC LIMIT 1",
    });
    const id = typeof result.rows?.[0]?.id === "string" ? result.rows[0].id : "0000";
    return id.match(/^\d+/)?.[0] ?? id;
}

function decodePgValueForSqlite(value) {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return value;
}

async function prepareSqliteTarget(sqlite, pgConn, tables) {
    for (const table of tables) {
        const columns = await pgColumns(pgConn, table);
        if (columns.length === 0) continue;
        if (sqliteTableExists(sqlite, table)) {
            if (table === "_smithers_schema_migrations") {
                continue;
            }
            const rowCount = countSqliteRows(sqlite, table);
            if (rowCount > 0) {
                throw new SmithersError("DB_WRITE_FAILED", `Target table ${table} already has ${rowCount} rows; refusing to merge a one-shot Smithers migration into a non-empty target.`, {
                    table,
                    rowCount,
                });
            }
            continue;
        }
        const columnSql = columns
            .map((column) => `${sqliteQuote(column.name)} ${sqliteTypeForPg(column.dataType)}${column.nullable ? "" : " NOT NULL"}`)
            .join(", ");
        sqlite.exec(`CREATE TABLE IF NOT EXISTS ${sqliteQuote(table)} (${columnSql})`);
    }
}

async function copyPgTableToSqlite(pgConn, sqlite, table, batchSize, opts) {
    const startedAt = Date.now();
    const columns = await pgColumns(pgConn, table);
    const sourceRows = await countPgRows(pgConn, table);
    await emitProgress({ type: "table-start", table, sourceRows }, opts);
    if (columns.length === 0) {
        return { table, sourceRows, targetRows: countSqliteRows(sqlite, table), durationMs: Date.now() - startedAt };
    }
    const names = columns.map((column) => column.name);
    const insert = sqlite.query(`INSERT INTO ${sqliteQuote(table)} (${names.map(sqliteQuote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
    let offset = 0;
    let copiedRows = 0;
    sqlite.exec("BEGIN");
    try {
        if (table === "_smithers_schema_migrations") {
            sqlite.exec(`DELETE FROM ${sqliteQuote(table)}`);
        }
        while (true) {
            const result = await pgConn.query({
                text: `SELECT ${names.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)} LIMIT $1 OFFSET $2`,
                values: [batchSize, offset],
            });
            const rows = result.rows ?? [];
            if (rows.length === 0) break;
            for (const row of rows) {
                insert.run(...names.map((column) => decodePgValueForSqlite(row[column])));
            }
            copiedRows += rows.length;
            offset += rows.length;
        }
        sqlite.exec("COMMIT");
    }
    catch (error) {
        try {
            sqlite.exec("ROLLBACK");
        }
        catch {}
        throw error;
    }
    const targetRows = countSqliteRows(sqlite, table);
    const durationMs = Date.now() - startedAt;
    await emitProgress({ type: "table-copied", table, copiedRows, sourceRows, targetRows, durationMs }, opts);
    return { table, sourceRows, targetRows, durationMs };
}

function sqliteRunCountAt(dbPath) {
    if (!existsSync(dbPath)) return 0;
    try {
        const sqlite = new Database(dbPath, { readonly: true });
        try {
            return sqliteTableExists(sqlite, "_smithers_runs") ? countSqliteRows(sqlite, "_smithers_runs") : 0;
        }
        finally {
            sqlite.close();
        }
    }
    catch {
        return 0;
    }
}

async function pgliteRunCountAt(cwd, workspaceRoot, opts) {
    const dataDir = resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg"));
    if (!existsSync(dataDir)) return 0;
    let api;
    try {
        api = await createSmithersPostgres({}, { provider: "pglite", dataDir });
        const pgConn = api.db.connection;
        return (await pgTableExists(pgConn, "_smithers_runs")) ? await countPgRows(pgConn, "_smithers_runs") : 0;
    }
    catch {
        return 0;
    }
    finally {
        await api?.close?.();
    }
}

async function inferSourceBackend(opts, cwd, workspaceRoot, dbPath, target) {
    if (opts.from) return normalizeBackend(opts.from);
    const counts = [
        { backend: "sqlite", runCount: sqliteRunCountAt(dbPath) },
        { backend: "pglite", runCount: await pgliteRunCountAt(cwd, workspaceRoot, opts) },
    ].filter((entry) => entry.runCount > 0);
    if (counts.length === 1) return counts[0].backend;
    if (counts.length > 1) {
        throw new SmithersError("SMITHERS_BACKEND_CONFLICT", "Multiple Smithers backend stores contain run history; pass --from explicitly before migrating.", {
            populatedBackends: counts.map((entry) => entry.backend),
        });
    }
    return "sqlite";
}

async function migratePgToSqlite(opts, context) {
    const { cwd, workspaceRoot, dbPath, target, sourceBackend, startedAt, batchSize } = context;
    const dataDir = resolve(cwd, opts.pgliteDataDir ?? join(workspaceRoot, ".smithers", "pg"));
    let sourceApi;
    let sqlite;
    try {
        sourceApi = await createSmithersPostgres({}, sourceBackend === "postgres"
            ? { provider: "postgres", connectionString: opts.url ?? context.env.SMITHERS_POSTGRES_URL ?? context.env.DATABASE_URL }
            : { provider: "pglite", dataDir });
        const pgConn = sourceApi.db.connection;
        if (!(await pgTableExists(pgConn, "_smithers_runs"))) {
            throw new SmithersError("CLI_DB_NOT_FOUND", `No ${sourceBackend} Smithers run store found.`, { sourceBackend });
        }
        const runCount = await countPgRows(pgConn, "_smithers_runs");
        const schemaVersion = await pgSchemaVersion(pgConn);
        const tables = (await pgTables(pgConn)).sort((a, b) => {
            const priority = tablePriority(a) - tablePriority(b);
            return priority === 0 ? a.localeCompare(b) : priority;
        });
        sqlite = new Database(dbPath);
        ensureSmithersTables(drizzle(sqlite));
        await prepareSqliteTarget(sqlite, pgConn, tables);
        const tableResults = [];
        for (const table of tables) {
            tableResults.push(await copyPgTableToSqlite(pgConn, sqlite, table, batchSize, opts));
        }
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
            source: sourceBackend === "postgres" ? { backend: sourceBackend, url: "set" } : { backend: sourceBackend, dataDir },
            dbPath,
            markerPath: markerPathFor(dbPath, workspaceRoot),
            target: { backend: "sqlite", dbPath },
            runCount,
            schemaVersion,
            durationMs,
            tables: tableResults,
            sqliteRemoved: false,
        };
        writeMigrationMarker(result, { sizeBytes: null, mtimeMs: null });
        writeBackendMarker(result);
        await emitProgress({
            type: "done",
            tableCount: tableResults.length,
            copiedRows: tableResults.reduce((sum, table) => sum + table.sourceRows, 0),
            durationMs,
        }, opts);
        return result;
    }
    catch (error) {
        throw withAgentFallback(error, sourceBackend, target);
    }
    finally {
        try { sqlite?.close(); } catch {}
        await sourceApi?.close?.();
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
    const target = normalizeBackend(opts.to, "sqlite");
    const sourceBackend = await inferSourceBackend(opts, cwd, workspaceRoot, dbPath, target);
    if (sourceBackend === target) {
        throw new SmithersError("INVALID_INPUT", `Migration source and target are both ${target}. Choose different --from and --to backends.`, {
            sourceBackend,
            target,
        });
    }
    if (sourceBackend === "sqlite" && !existsSync(dbPath)) {
        throw new SmithersError("CLI_DB_NOT_FOUND", `No legacy SQLite store found at ${dbPath}.`, {
            dbPath,
        });
    }
    // Validate the Postgres connection target BEFORE opening the source store, so
    // `migrate --to postgres` with no url fails fast with a clear INVALID_INPUT
    // instead of being masked by an unrelated source-open error (e.g. an
    // unreadable or sidecar-less smithers.db).
    const postgresUrl = target === "postgres" ? (opts.url ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL) : undefined;
    if (target === "postgres" && !postgresUrl) {
        throw new SmithersError("INVALID_INPUT", "smithers migrate --to postgres requires --url, SMITHERS_POSTGRES_URL, or DATABASE_URL.", {
            target,
        });
    }
    if (sourceBackend === "postgres" && !(opts.url ?? env.SMITHERS_POSTGRES_URL ?? env.DATABASE_URL)) {
        throw new SmithersError("INVALID_INPUT", "smithers migrate --from postgres requires --url, SMITHERS_POSTGRES_URL, or DATABASE_URL.", {
            sourceBackend,
        });
    }
    if (target === "sqlite" && sourceBackend !== "sqlite") {
        return migratePgToSqlite(opts, { cwd, env, workspaceRoot, dbPath, target, sourceBackend, startedAt, batchSize: Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)) });
    }
    if (sourceBackend !== "sqlite") {
        throw new SmithersError("INVALID_INPUT", `Migration from ${sourceBackend} to ${target} is not implemented yet.`, {
            sourceBackend,
            target,
        });
    }
    const markerPath = markerPathFor(dbPath, workspaceRoot);
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
    const keepSqlite = opts.keepSqlite ?? true;
    const sourceStats = sourceFileStats(dbPath);
    /** @type {Database | undefined} */
    let sqlite;
    /** @type {(import("./CreateSmithersApi.ts").CreateSmithersApi<Record<string, import("zod").ZodObject<any>>> & { close?: () => Promise<void> }) | undefined} */
    let targetApi;
    try {
        const source = openSourceStore(dbPath);
        sqlite = source.sqlite;
        const { runCount, schemaVersion, tables, indexes } = source;
        await emitMigrationLog("info", "smithers.migration.started", {
            dbPath,
            target,
            tableCount: tables.length,
            runCount,
            schemaVersion,
        }, "smithers:migrate");
        if (target === "postgres") {
            targetApi = await createSmithersPostgres({}, {
                provider: "postgres",
                connectionString: postgresUrl,
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
            source: { backend: "sqlite", dbPath },
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
        writeBackendMarker(result);
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
        throw withAgentFallback(error, sourceBackend, target);
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
