import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
export function validateOutput(table, payload) {
    const schema = createInsertSchema(table);
    const result = schema.safeParse(payload);
    if (result.success) {
        return { ok: true, data: result.data };
    }
    return { ok: false, error: result.error };
}
