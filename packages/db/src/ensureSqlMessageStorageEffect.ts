import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
export declare function ensureSqlMessageStorageEffect(db: BunSQLiteDatabase<any> | Database): Effect.Effect<void, never>;
