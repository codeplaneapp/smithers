import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Layer } from "effect";
import { MemoryStoreDb } from "./MemoryStoreDb";
import { MemoryStoreLive } from "./MemoryStoreLive";

export function createMemoryStoreLayer(db: BunSQLiteDatabase<any>) {
  return MemoryStoreLive.pipe(
    Layer.provide(Layer.succeed(MemoryStoreDb, db)),
  );
}
