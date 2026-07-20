import type { Table } from "drizzle-orm";

export type SchemaRegistryEntry = {
  table: Table;
  zodSchema: import("zod").ZodObject;
};
