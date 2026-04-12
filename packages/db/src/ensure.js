import { Effect } from "effect";
import { ensureSqlMessageStorageEffect } from "./sql-message-storage.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */
/** @typedef {import("@smithers/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {BunSQLiteDatabase<any>} db
 * @returns {Effect.Effect<void, SmithersError>}
 */
export function ensureSmithersTablesEffect(db) {
    return ensureSqlMessageStorageEffect(db).pipe(Effect.withLogSpan("db:ensure-smithers-tables"));
}
/**
 * @param {BunSQLiteDatabase<any>} db
 */
export function ensureSmithersTables(db) {
    Effect.runSync(ensureSmithersTablesEffect(db));
}
