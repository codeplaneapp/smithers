import type { Table } from "drizzle-orm";
import type { OutputKey } from "./OutputKey";
export declare function buildKeyWhere(table: Table, key: OutputKey): import("drizzle-orm").SQL<unknown> | undefined;
