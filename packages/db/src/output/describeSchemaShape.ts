import type { Table } from "drizzle-orm";
import { z } from "zod";
/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
export declare function describeSchemaShape(tableOrSchema: Table | z.ZodObject<any>, zodSchema?: z.ZodObject<any>): string;
