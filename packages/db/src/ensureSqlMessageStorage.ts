import { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
export declare function ensureSqlMessageStorage(db: BunSQLiteDatabase<any> | Database): Promise<void>;
