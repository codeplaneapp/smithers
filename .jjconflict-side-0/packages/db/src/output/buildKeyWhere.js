import { and, eq } from "drizzle-orm";
import { getKeyColumns } from "./getKeyColumns.js";
/** @typedef {import("./OutputKey.ts").OutputKey} OutputKey */
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table} table
 * @param {OutputKey} key
 */
export function buildKeyWhere(table, key) {
    const cols = getKeyColumns(table);
    const clauses = [eq(cols.runId, key.runId), eq(cols.nodeId, key.nodeId)];
    if (cols.iteration) {
        clauses.push(eq(cols.iteration, key.iteration ?? 0));
    }
    return and(...clauses);
}
