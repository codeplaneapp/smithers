import { Database } from "bun:sqlite";
import { SqlMessageStorage } from "./SqlMessageStorage.js";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase} BunSQLiteDatabase */

/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {SqlMessageStorage}
 */
export function getSqlMessageStorage(db) {
    return new SqlMessageStorage(db);
}
