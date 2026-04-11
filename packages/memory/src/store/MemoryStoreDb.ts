import { Context } from "effect";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export const MemoryStoreDb = Context.GenericTag<BunSQLiteDatabase<any>>(
  "MemoryStoreDb",
);
