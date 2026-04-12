import { z } from "zod";
import { getAgentOutputSchema } from "./getAgentOutputSchema.js";
/**
 * Describes a schema as a JSON Schema string for agent prompts.
 * Prefers the original Zod schema's `.toJSONSchema()` (Zod 4) which preserves
 * field descriptions. Falls back to deriving from the Drizzle table.
 */
export function describeSchemaShape(tableOrSchema, zodSchema) {
    // Prefer the original Zod schema which has .describe() annotations
    const schema = zodSchema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : null);
    if (schema && typeof schema.toJSONSchema === "function") {
        const jsonSchema = schema.toJSONSchema();
        return JSON.stringify(jsonSchema, null, 2);
    }
    // Fallback: derive from Drizzle table
    if (!isZodSchema(tableOrSchema)) {
        const agentSchema = getAgentOutputSchema(tableOrSchema);
        if (typeof agentSchema.toJSONSchema === "function") {
            const jsonSchema = agentSchema.toJSONSchema();
            return JSON.stringify(jsonSchema, null, 2);
        }
    }
    // Last resort: manual description
    const target = schema ?? (isZodSchema(tableOrSchema) ? tableOrSchema : getAgentOutputSchema(tableOrSchema));
    const shape = target.shape;
    const fields = {};
    for (const [key, zodType] of Object.entries(shape)) {
        fields[key] = describeZodType(zodType);
    }
    return JSON.stringify(fields, null, 2);
}
/**
 * @param {any} val
 * @returns {val is z.ZodObject<any>}
 */
function isZodSchema(val) {
    return val && typeof val === "object" && "shape" in val && typeof val.shape === "object";
}
/**
 * @param {z.ZodType} schema
 * @returns {string}
 */
function describeZodType(schema) {
    // Zod v4: uses _zod.def
    if (schema._zod?.def) {
        const def = schema._zod.def;
        const typeName = def.type;
        if (typeName === "optional" || typeName === "default" || typeName === "nullable") {
            const inner = def.innerType ? describeZodType(def.innerType) : "unknown";
            if (typeName === "optional")
                return `${inner} (optional)`;
            if (typeName === "nullable")
                return `${inner} | null`;
            return inner;
        }
        if (typeName === "string")
            return "string";
        if (typeName === "number" || typeName === "int" || typeName === "float")
            return "number";
        if (typeName === "boolean")
            return "boolean";
        if (typeName === "array") {
            const itemType = def.element ? describeZodType(def.element) : "unknown";
            return `${itemType}[]`;
        }
        if (typeName === "object")
            return "object";
        if (typeName === "enum")
            return `enum(${(def.values ?? []).join(" | ")})`;
        if (typeName === "literal")
            return `literal(${JSON.stringify(def.value)})`;
        if (typeName === "union") {
            const options = (def.options ?? []).map((o) => describeZodType(o));
            return options.join(" | ");
        }
    }
    return "unknown";
}
