import { eq } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Effect, Option } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("@smithers/driver/OutputSnapshot").OutputSnapshot} OutputSnapshot */

/**
 * Detect columns declared with `{ mode: "boolean" }` in a Drizzle table.
 * bun:sqlite returns raw INTEGER 0/1 for these columns instead of JS booleans,
 * which breaks strict equality checks like `value === true`.
 */
function getBooleanColumnKeys(table) {
    try {
        const cols = getTableColumns(table);
        const keys = [];
        for (const [key, col] of Object.entries(cols)) {
            // Check all known ways drizzle exposes boolean mode
            const c = col;
            if (c?.columnType === "SQLiteBoolean" ||
                c?.config?.mode === "boolean" ||
                c?.mode === "boolean" ||
                c?.mapFromDriverValue?.toString().includes("Boolean") ||
                // Drizzle integer({ mode: "boolean" }) sets dataType to "integer"
                // and stores mode in the config — check the column's JS name hints
                (c?.dataType === "boolean")) {
                keys.push(key);
            }
        }
        return keys;
    }
    catch {
        return [];
    }
}
/**
 * Coerce integer 0/1 values to proper JS booleans for boolean-mode columns.
 */
function coerceBooleanColumns(rows, boolKeys) {
    if (boolKeys.length === 0)
        return rows;
    return rows.map((row) => {
        if (!row)
            return row;
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
 * @param {any} db
 * @param {Record<string, any>} schema
 * @param {string} runId
 * @returns {Effect.Effect<OutputSnapshot, SmithersError>}
 */
export function loadOutputs(db, schema, runId) {
    return Effect.gen(function* () {
        const out = {};
        for (const [key, table] of Object.entries(schema)) {
            if (!table || typeof table !== "object")
                continue;
            if (key === "input")
                continue;
            const colsOpt = yield* Effect.try({
                try: () => getTableColumns(table),
                catch: (cause) => toSmithersError(cause, "get table columns", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(colsOpt))
                continue;
            const cols = colsOpt.value;
            const runIdCol = cols.runId;
            if (!runIdCol)
                continue;
            const tableNameOpt = yield* Effect.try({
                try: () => getTableName(table),
                catch: (cause) => toSmithersError(cause, "get table name", { code: "DB_QUERY_FAILED", details: { runId, schemaKey: key } }),
            }).pipe(Effect.option);
            if (Option.isNone(tableNameOpt))
                continue;
            const tableName = tableNameOpt.value;
            const rawRows = yield* Effect.tryPromise({
                try: () => db
                    .select()
                    .from(table)
                    .where(eq(runIdCol, runId)),
                catch: (cause) => toSmithersError(cause, `load outputs ${tableName}`, {
                    code: "DB_QUERY_FAILED",
                    details: { runId, tableName },
                }),
            });
            const boolKeys = getBooleanColumnKeys(table);
            const rows = coerceBooleanColumns(rawRows, boolKeys);
            out[tableName] = rows;
            out[key] = rows;
        }
        return out;
    }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("db:load-outputs"));
}
