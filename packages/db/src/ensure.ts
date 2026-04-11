import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSqlMessageStorageEffect } from "./sql-message-storage";
import type { SmithersError } from "@smithers/errors/SmithersError";

export function ensureSmithersTablesEffect(
  db: BunSQLiteDatabase<any>,
): Effect.Effect<void, SmithersError> {
  return ensureSqlMessageStorageEffect(db).pipe(
    Effect.withLogSpan("db:ensure-smithers-tables"),
  ) as Effect.Effect<void, SmithersError>;
}

export function ensureSmithersTables(db: BunSQLiteDatabase<any>): void {
  Effect.runSync(ensureSmithersTablesEffect(db));
}
