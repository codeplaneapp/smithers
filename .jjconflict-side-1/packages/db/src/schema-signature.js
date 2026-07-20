import { getTableName } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { createHash } from "node:crypto";
/** @typedef {import("drizzle-orm").Table} _Table */

/**
 * @param {_Table} table
 * @returns {string}
 */
export function schemaSignature(table) {
    const cols = getTableColumns(table);
    const keys = Object.keys(cols).sort();
    const parts = [getTableName(table)];
    for (const key of keys) {
        const col = cols[key];
        const type = col?.columnType ?? col?.dataType ?? col?.getSQLType?.() ?? "unknown";
        const notNull = col?.notNull ? "1" : "0";
        const primary = col?.primary ? "1" : "0";
        parts.push(`${key}:${type}:${notNull}:${primary}`);
    }
    return createHash("sha256").update(parts.join("|")).digest("hex");
}
