import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { runSync } from "@smithers/runtime/runtime";
import type { MemoryStore } from "./MemoryStore";
import { MemoryStoreService } from "./MemoryStoreService";
import { createMemoryStoreLayer } from "./createMemoryStoreLayer";

export function createMemoryStore(db: BunSQLiteDatabase<any>): MemoryStore {
  return runSync(
    MemoryStoreService.pipe(Effect.provide(createMemoryStoreLayer(db))),
  );
}
