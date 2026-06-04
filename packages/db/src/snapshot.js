import { eq, getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Option } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {Record<string, Array<unknown>>} OutputSnapshot */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm").Table} _Table */

/**
 * @param {_Table} table
 * @returns {string[]}
 */
function getBooleanColumnKeys(table) {
    try {
        const cols = getTableColumns(table);
        const keys = [];
        for (const [key, col] of Object.entries(cols)) {
            const c = /** @type {Record<string, unknown> & { config?: { mode?: string }; mapFromDriverValue?: unknown }} */ (/** @type {unknown} */ (col));
            const mapFn = /** @type {{ toString?: () => string } | undefined} */ (c?.mapFromDriverValue);
            if (c?.columnType === "SQLiteBoolean" || c?.config?.mode === "boolean" || c?.mode === "boolean" || mapFn?.toString?.().includes("Boolean") || (c?.dataType === "boolean")) {
                keys.push(key);
            }
        }
        return keys;
    } catch {
        return [];
    }
}
/**
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {readonly string[]} boolKeys
 * @returns {Array<Record<string, unknown>>}
 */
function coerceBooleanColumns(rows, boolKeys) {
    if (boolKeys.length === 0) return rows.slice();
    return rows.map((row) => {
        if (!row) return row;
        /** @type {Record<string, unknown>} */
        const patched = { ...row };
        for (const key of boolKeys) {
            if (key in patched && typeof patched[key] !== "boolean") {
                patched[key] = Boolean(patched[key]);
            }
        }
        return patched;
    });
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Effect.Effect<Record<string, unknown> | undefined, SmithersError>}
 */
/**
 * @param {unknown} db
 * @returns {boolean}
 */
export function isPostgresDb(db) {
    return Boolean(db && typeof db === "object" && /** @type {any} */ (db).dialect === "postgres" && /** @type {any} */ (db).connection);
}
/**
 * Map a raw node-postgres row (snake_case columns, JSON stored as TEXT) into the
 * shape Drizzle's bun:sqlite reader returns (camelCase keys, parsed `payload`),
 * so input/output consumers stay dialect-agnostic.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function pgRowToDrizzle(row) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [columnName, value] of Object.entries(row)) {
        const camel = columnName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (camel === "payload" && typeof value === "string") {
            try {
                out[camel] = JSON.parse(value);
            }
            catch {
                out[camel] = value;
            }
        }
        else {
            out[camel] = value;
        }
    }
    return out;
}
export function loadInputEffect(db, inputTable, runId) {
    return Effect.suspend(() => {
        const cols = getTableColumns(inputTable);
        const runIdCol = cols.runId;
        if (!runIdCol) {
            return Effect.fail(new SmithersError("DB_MISSING_COLUMNS", "schema.input must include runId column"));
        }
        if (isPostgresDb(db)) {
            const tableName = getTableName(inputTable).replaceAll(`"`, `""`);
            return Effect.tryPromise({
                try: () => db.connection
                    .query({ text: `SELECT * FROM "${tableName}" WHERE run_id = $1 LIMIT 1`, values: [runId] })
                    .then((result) => (result.rows[0] ? pgRowToDrizzle(result.rows[0]) : undefined)),
                catch: (cause) => toSmithersError(cause, "load input", {
                    code: "DB_QUERY_FAILED",
                    details: { runId },
                }),
            });
        }
        return Effect.tryPromise({
            try: () => db.select().from(inputTable).where(eq(runIdCol, runId)).limit(1),
            catch: (cause) => toSmithersError(cause, "load input", {
                code: "DB_QUERY_FAILED",
                details: { runId },
            }),
        }).pipe(Effect.map((rows) => rows[0]));
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-input"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {_Table} inputTable
 * @param {string} runId
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export function loadInput(db, inputTable, runId) {
    return Effect.runPromise(loadInputEffect(db, inputTable, runId));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Effect.Effect<OutputSnapshot, SmithersError>}
 */
export function loadOutputsEffect(db, schema, runId) {
    return Effect.gen(function* () {
        /** @type {Record<string, ReadonlyArray<Record<string, unknown>>>} */
        const out = {};
        for (const [key, table] of Object.entries(schema)) {
            if (!table || typeof table !== "object") continue;
            if (key === "input") continue;
            const colsOpt = yield* Effect.try({
                try: () => getTableColumns(/** @type {_Table} */ (table)),
                catch: (cause) => toSmithersError(cause, "get table columns", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(colsOpt)) continue;
            const cols = colsOpt.value;
            const runIdCol = cols.runId;
            if (!runIdCol) continue;
            const tableNameOpt = yield* Effect.try({
                try: () => getTableName(/** @type {_Table} */ (table)),
                catch: (cause) => toSmithersError(cause, "get table name", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(tableNameOpt)) continue;
            const tableName = tableNameOpt.value;
            const rawRows = yield* Effect.tryPromise({
                try: () => isPostgresDb(db)
                    ? db.connection
                        .query({ text: `SELECT * FROM "${tableName.replaceAll(`"`, `""`)}" WHERE run_id = $1`, values: [runId] })
                        .then((result) => result.rows.map(pgRowToDrizzle))
                    : db.select().from(/** @type {_Table} */ (table)).where(eq(runIdCol, runId)),
                catch: (cause) => toSmithersError(cause, `load outputs ${tableName}`, { code: "DB_QUERY_FAILED", details: { runId, tableName } }),
            });
            const boolKeys = getBooleanColumnKeys(/** @type {_Table} */ (table));
            const rows = coerceBooleanColumns(rawRows, boolKeys);
            out[tableName] = rows;
            out[key] = rows;
        }
        return /** @type {OutputSnapshot} */ (/** @type {unknown} */ (out));
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-outputs"));
}
/**
 * @param {BunSQLiteDatabase<Record<string, unknown>>} db
 * @param {Record<string, _Table | unknown>} schema
 * @param {string} runId
 * @returns {Promise<OutputSnapshot>}
 */
export function loadOutputs(db, schema, runId) {
    return Effect.runPromise(loadOutputsEffect(db, schema, runId));
}
/**
 * Read every row of a single output table for a run, returning Drizzle-shaped
 * rows (camelCase keys, boolean columns coerced to JS booleans). Dialect-aware:
 * Drizzle for bun:sqlite, a raw `$n` query for the Postgres descriptor.
 * @param {unknown} db
 * @param {_Table} table
 * @param {string} [runId]
 * @returns {Effect.Effect<Array<Record<string, unknown>>, SmithersError>}
 */
export function loadRunOutputRowsEffect(db, table, runId) {
    return Effect.gen(function* () {
        const cols = getTableColumns(table);
        const runIdCol = cols.runId;
        const tableName = getTableName(table);
        const boolKeys = getBooleanColumnKeys(table);
        const rawRows = yield* Effect.tryPromise({
            try: () => {
                if (isPostgresDb(db)) {
                    const escaped = tableName.replaceAll(`"`, `""`);
                    const text = runId && runIdCol
                        ? `SELECT * FROM "${escaped}" WHERE run_id = $1`
                        : `SELECT * FROM "${escaped}"`;
                    const values = runId && runIdCol ? [runId] : [];
                    return db.connection
                        .query({ text, values })
                        .then((result) => result.rows.map(pgRowToDrizzle));
                }
                return runId && runIdCol
                    ? db.select().from(table).where(eq(runIdCol, runId))
                    : db.select().from(table);
            },
            catch: (cause) => toSmithersError(cause, `load run output ${tableName}`, {
                code: "DB_QUERY_FAILED",
                details: { runId, tableName },
            }),
        });
        return coerceBooleanColumns(rawRows, boolKeys);
    }).pipe(Effect.annotateLogs({ runId: runId ?? "" }), Effect.withLogSpan("db:load-run-output"));
}
