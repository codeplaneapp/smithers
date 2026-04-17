import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
/** @typedef {import("drizzle-orm").Table} _Table */

/**
 * @param {_Table} table
 * @param {unknown} payload
 * @returns {{ ok: boolean; data?: any; error?: z.ZodError; }}
 */
export function validateInput(table, payload) {
    const schema = createInsertSchema(table);
    const result = schema.safeParse(payload);
    if (result.success) {
        return { ok: true, data: result.data };
    }
    return { ok: false, error: result.error };
}
