import { getAgentOutputSchema } from "./getAgentOutputSchema.js";
import { z } from "zod";
/** @typedef {import("drizzle-orm").Table} Table */

/**
 * @param {Table | z.ZodObject} tableOrSchema
 * @param {z.ZodObject} [zodSchema]
 * @returns {string}
 */
export function describeSchemaShape(tableOrSchema, zodSchema) {
    const schema = zodSchema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : null);
    const describedSchema = tryDescribeJsonSchema(schema);
    if (describedSchema)
        return describedSchema;
    if (!isZodSchema(tableOrSchema)) {
        const agentSchema = getAgentOutputSchema(tableOrSchema);
        const describedAgentSchema = tryDescribeJsonSchema(agentSchema);
        if (describedAgentSchema)
            return describedAgentSchema;
    }
    const target = schema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : getAgentOutputSchema(tableOrSchema));
    const shape = target.shape;
    /** @type {Record<string, string>} */
    const fields = {};
    for (const [key, zodType] of Object.entries(shape)) {
        fields[key] = describeZodType(/** @type {z.ZodType} */ (zodType));
    }
    return JSON.stringify(fields, null, 2);
}
/**
 * @param {unknown} val
 * @returns {val is z.ZodObject}
 */
function isZodSchema(val) {
    return (!!val && typeof val === "object" && "shape" in val && typeof (/** @type {{ shape: unknown }} */ (val)).shape === "object");
}
/**
 * @param {z.ZodType | null} schema
 * @returns {string | null}
 */
function tryDescribeJsonSchema(schema) {
    if (!schema)
        return null;
    if (typeof z.toJSONSchema === "function") {
        try {
            return JSON.stringify(z.toJSONSchema(schema, { io: "output" }), null, 2);
        }
        catch { }
    }
    if (typeof schema.toJSONSchema === "function") {
        try {
            return JSON.stringify(schema.toJSONSchema(), null, 2);
        }
        catch { }
    }
    return null;
}
/**
 * @param {z.ZodType} schema
 * @returns {string}
 */
function describeZodType(schema) {
    const internal = /** @type {{ _zod?: { def?: Record<string, unknown> } }} */ (/** @type {unknown} */ (schema));
    if (internal._zod?.def) {
        const def = internal._zod.def;
        const typeName = /** @type {string} */ (def.type);
        if (typeName === "optional" || typeName === "default" || typeName === "nullable") {
            const inner = def.innerType ? describeZodType(/** @type {z.ZodType} */ (def.innerType)) : "unknown";
            if (typeName === "optional") return `${inner} (optional)`;
            if (typeName === "nullable") return `${inner} | null`;
            return inner;
        }
        if (typeName === "string") return "string";
        if (typeName === "number" || typeName === "int" || typeName === "float") return "number";
        if (typeName === "boolean") return "boolean";
        if (typeName === "array") {
            const itemType = def.element ? describeZodType(/** @type {z.ZodType} */ (def.element)) : "unknown";
            return `${itemType}[]`;
        }
        if (typeName === "object") return "object";
        if (typeName === "enum") return `enum(${(/** @type {unknown[]} */ (def.values ?? [])).join(" | ")})`;
        if (typeName === "literal") return `literal(${JSON.stringify(def.value)})`;
        if (typeName === "union") {
            const options = (/** @type {z.ZodType[]} */ (def.options ?? [])).map((o) => describeZodType(o));
            return options.join(" | ");
        }
    }
    return "unknown";
}
