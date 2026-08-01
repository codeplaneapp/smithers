import { Context } from "effect";
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<any>} BunSQLiteDatabaseAny */

/** @type {Context.Service<BunSQLiteDatabaseAny, BunSQLiteDatabaseAny>} */
export const MemoryStoreDb = Context.Service("MemoryStoreDb");
