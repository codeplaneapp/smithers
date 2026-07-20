import { sqliteTable, text, integer, real, primaryKey, } from "drizzle-orm/sqlite-core";
import { assertZodV4 } from "@smithers-orchestrator/errors/assertZodV4";
import { assertNoReservedColumns } from "./assertNoReservedColumns.js";
import { unwrapZodType } from "./unwrapZodType.js";
import { camelToSnake } from "./utils/camelToSnake.js";
/**
 * Determines the Zod base type name from a (possibly unwrapped) Zod type.
 */
function getZodBaseTypeName(zodType) {
    return zodType._zod?.def?.type ?? "unknown";
}
function isIntegerNumberType(zodType, baseTypeName) {
    if (baseTypeName === "int")
        return true;
    const def = zodType._zod?.def;
    return def?.format === "safeint" ||
        def?.checks?.some((check) => check?._zod?.def?.check === "number_format");
}
function literalValue(zodType) {
    const values = zodType._zod?.def?.values;
    if (Array.isArray(values))
        return values.length === 1 ? values[0] : undefined;
    return zodType.value;
}
/**
 * Generates a Drizzle sqliteTable from a Zod object schema.
 *
 * Each Zod field is mapped to a SQLite column:
 * - z.string() / z.enum() -> text column
 * - z.number() -> real column
 * - z.boolean() -> integer column with boolean mode
 * - z.array() / z.object() / complex -> text column with json mode
 *
 * All tables include standard smithers key columns:
 * runId, nodeId, iteration with a composite primary key.
 */
export function zodToTable(tableName, schema, opts) {
    // A Zod v3 schema has no `_zod`, so getZodBaseTypeName below would silently
    // resolve every field to "unknown" and degrade every column to JSON text.
    // Reject it up front with an actionable error instead.
    assertZodV4(schema, tableName);
    assertNoReservedColumns(schema, tableName, opts);
    const columns = opts?.isInput
        ? { runId: text("run_id").primaryKey() }
        : {
            runId: text("run_id").notNull(),
            nodeId: text("node_id").notNull(),
            iteration: integer("iteration").notNull().default(0),
        };
    const shape = schema.shape;
    for (const [key, zodType] of Object.entries(shape)) {
        const colName = camelToSnake(key);
        const baseType = unwrapZodType(zodType);
        const baseTypeName = getZodBaseTypeName(baseType);
        const literal = baseTypeName === "literal" ? literalValue(baseType) : undefined;
        if (typeof literal === "number") {
            columns[key] = Number.isInteger(literal) ? integer(colName) : real(colName);
        }
        else if (typeof literal === "boolean") {
            columns[key] = integer(colName, { mode: "boolean" });
        }
        else if (isIntegerNumberType(baseType, baseTypeName)) {
            columns[key] = integer(colName);
        }
        else if (baseTypeName === "number" || baseTypeName === "float") {
            columns[key] = real(colName);
        }
        else if (baseTypeName === "boolean") {
            columns[key] = integer(colName, { mode: "boolean" });
        }
        else if (baseTypeName === "string" ||
            baseTypeName === "enum" ||
            (baseTypeName === "literal" && typeof literal === "string")) {
            columns[key] = text(colName);
        }
        else {
            // arrays, objects, unions, and anything complex -> JSON text
            columns[key] = text(colName, { mode: "json" });
        }
    }
    if (opts?.isInput) {
        return sqliteTable(tableName, columns);
    }
    return sqliteTable(tableName, columns, (t) => [
        primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }),
    ]);
}
