import { Database } from "bun:sqlite";
import { getSqlMessageStorage } from "./getSqlMessageStorage.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Promise<void>}
 */
export function ensureSqlMessageStorage(db) {
    return getSqlMessageStorage(db).ensureSchema();
}
