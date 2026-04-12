import { z } from "zod";
/**
 * Generates a CREATE TABLE IF NOT EXISTS SQL statement from a Zod schema.
 * Used for runtime table creation without Drizzle migrations.
 */
export declare function zodToCreateTableSQL(tableName: string, schema: z.ZodObject<any>, opts?: {
    isInput?: boolean;
}): string;
