import { unwrapZodType } from "./unwrapZodType.js";
import { camelToSnake } from "./utils/camelToSnake.js";
/**
 * Determines the Zod base type name from a (possibly unwrapped) Zod type.
 */
function getZodBaseTypeName(zodType) {
    return zodType._zod?.def?.type ?? "unknown";
}
function sqliteTypeFor(zodFieldSchema) {
    const baseType = unwrapZodType(zodFieldSchema);
    const baseTypeName = getZodBaseTypeName(baseType);
    if (baseTypeName === "number" ||
        baseTypeName === "int" ||
        baseTypeName === "float" ||
        baseTypeName === "boolean") {
        return "INTEGER";
    }
    return "TEXT";
}
function quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll(`"`, `""`)}"`;
}
/**
 * Returns the user-defined columns derived from a Zod schema (excluding the
 * fixed run_id/node_id/iteration prefix). Each entry is `{ name, sqliteType }`.
 */
export function zodSchemaColumns(schema) {
    const out = [];
    const shape = schema.shape;
    for (const [key] of Object.entries(shape)) {
        out.push({ name: camelToSnake(key), sqliteType: sqliteTypeFor(shape[key]) });
    }
    return out;
}
/**
 * Generates a CREATE TABLE IF NOT EXISTS SQL statement from a Zod schema.
 * Used for runtime table creation without Drizzle migrations.
 */
export function zodToCreateTableSQL(tableName, schema, opts) {
    const colDefs = opts?.isInput
        ? [`run_id TEXT NOT NULL PRIMARY KEY`]
        : [
            `run_id TEXT NOT NULL`,
            `node_id TEXT NOT NULL`,
            `iteration INTEGER NOT NULL DEFAULT 0`,
        ];
    for (const { name, sqliteType } of zodSchemaColumns(schema)) {
        colDefs.push(`"${name}" ${sqliteType}`);
    }
    if (!opts?.isInput) {
        colDefs.push(`PRIMARY KEY (run_id, node_id, iteration)`);
    }
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${colDefs.join(", ")})`;
}
/**
 * Ensures `tableName` exists with all columns implied by `schema`, adding
 * any missing columns via ALTER TABLE. Idempotent and safe to call on every
 * boot — fixes the case where the schema evolves but the table was created
 * by an earlier version (CREATE TABLE IF NOT EXISTS would silently no-op).
 *
 * `sqlite` must be a `bun:sqlite` Database (or compatible) exposing
 * `.run(sql)` and `.query(sql).all()`.
 */
export function syncZodTableSchema(sqlite, tableName, schema, opts) {
    sqlite.run(zodToCreateTableSQL(tableName, schema, opts));
    let existing;
    const quotedTable = quoteIdentifier(tableName);
    try {
        existing = sqlite.query(`PRAGMA table_info(${quotedTable})`).all();
    }
    catch {
        return;
    }
    const have = new Set(existing.map((row) => row?.name).filter((n) => typeof n === "string"));
    for (const { name, sqliteType } of zodSchemaColumns(schema)) {
        if (have.has(name))
            continue;
        try {
            sqlite.run(`ALTER TABLE ${quotedTable} ADD COLUMN ${quoteIdentifier(name)} ${sqliteType}`);
        }
        catch {
            // Concurrent boot, or column added since the PRAGMA snapshot — ignore.
        }
    }
}
