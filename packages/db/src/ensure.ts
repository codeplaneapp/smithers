import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
export declare function ensureSmithersTablesEffect(db: BunSQLiteDatabase<any>): Effect.Effect<void, SmithersError>;
export declare function ensureSmithersTables(db: BunSQLiteDatabase<any>): void;
