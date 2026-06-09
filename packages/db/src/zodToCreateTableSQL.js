import { unwrapZodType } from "./unwrapZodType.js";
import { columnType, SQLITE } from "./dialect.js";
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
function sqliteKindFor(zodFieldSchema) {
    const baseType = unwrapZodType(zodFieldSchema);
    const baseTypeName = getZodBaseTypeName(baseType);
    if (baseTypeName === "boolean")
        return "boolean";
    if (baseTypeName === "number" ||
        baseTypeName === "int" ||
        baseTypeName === "float")
        return "number";
    if (baseTypeName === "string" ||
        baseTypeName === "enum" ||
        baseTypeName === "literal")
        return "string";
    return "json";
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
        out.push({ name: camelToSnake(key), sqliteType: sqliteTypeFor(shape[key]), kind: sqliteKindFor(shape[key]) });
    }
    return out;
}
/**
 * Generates a CREATE TABLE IF NOT EXISTS SQL statement from a Zod schema.
 * Used for runtime table creation without Drizzle migrations. Pass
 * `opts.dialect` to emit PostgreSQL-compatible column types; the default
 * (`sqlite`) is byte-identical to the historical output.
 */
export function zodToCreateTableSQL(tableName, schema, opts) {
    const dialect = opts?.dialect ?? SQLITE;
    const integer = columnType(dialect, "INTEGER");
    const colDefs = opts?.isInput
        ? [`run_id TEXT NOT NULL PRIMARY KEY`]
        : [
            `run_id TEXT NOT NULL`,
            `node_id TEXT NOT NULL`,
            `iteration ${integer} NOT NULL DEFAULT 0`,
        ];
    for (const { name, sqliteType } of zodSchemaColumns(schema)) {
        colDefs.push(`"${name}" ${columnType(dialect, sqliteType)}`);
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
    if (!opts?.isInput) {
        try {
            sqlite.run(`CREATE TABLE IF NOT EXISTS _smithers_output_schema_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (table_name, column_name))`);
            const stmt = sqlite.query(`INSERT INTO _smithers_output_schema_columns (table_name, column_name, kind) VALUES (?, ?, ?) ON CONFLICT(table_name, column_name) DO UPDATE SET kind = excluded.kind`);
            for (const { name, kind } of zodSchemaColumns(schema)) {
                stmt.run(tableName, name, kind);
            }
        }
        catch {
            // Schema metadata is best-effort; table creation remains the source of truth.
        }
    }
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
