import type { Table } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { OutputKey } from "./OutputKey";
export declare function upsertOutputRow(db: any, table: Table, key: OutputKey, payload: Record<string, unknown>): Effect.Effect<void, SmithersError>;
