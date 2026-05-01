import { getSqlMessageStorage } from "./getSqlMessageStorage.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Effect.Effect<void, never>}
 */
export function ensureSqlMessageStorageEffect(db) {
    return getSqlMessageStorage(db).ensureSchemaEffect();
}
