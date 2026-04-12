import type { Table } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { OutputKey } from "./OutputKey";
export declare function selectOutputRow<T>(db: any, table: Table, key: OutputKey): Effect.Effect<T | undefined, SmithersError>;
