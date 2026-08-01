import { Effect } from "effect";
import { MemoryStoreService } from "./MemoryStoreService.js";
import { createMemoryStoreLayer } from "./createMemoryStoreLayer.js";
/** @typedef {import("./MemoryStore.ts").MemoryStore} MemoryStore */

/**
 * @param {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<any>} db
 * @returns {MemoryStore}
 */
export function createMemoryStore(db) {
  return Effect.runSync(MemoryStoreService.pipe(Effect.provide(createMemoryStoreLayer(db))));
}
