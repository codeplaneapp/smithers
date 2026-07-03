
/** @typedef {import("zod").ZodObject<import("zod").ZodRawShape>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {ZodObject} schema
 * @returns {string}
 */
export function zodSchemaToJsonExample(schema) {
    /** @type {Record<string, unknown>} */
    const example = {};
    for (const [key, field] of Object.entries(schema.shape)) {
        example[key] = zodFieldToExample(/** @type {ZodTypeAny} */ (field));
    }
    return JSON.stringify(example, null, 2);
}
/**
 * @param {ZodTypeAny} field
 * @returns {unknown}
 */
function zodFieldToExample(field) {
    const anyField = /** @type {{
        description?: string;
        _def?: { description?: string };
        _zod?: {
            bag?: { description?: string };
            def?: {
                type?: string;
                description?: string;
                element?: ZodTypeAny;
                values?: unknown[];
                entries?: Record<string, unknown>;
                innerType?: ZodTypeAny;
                defaultValue?: unknown;
            };
        };
        shape?: Record<string, ZodTypeAny>;
    }} */ (/** @type {unknown} */ (field));
    const zod = anyField._zod;
    const def = zod?.def;
    if (!def)
        return "value";
    const description = anyField.description ??
        anyField._def?.description ??
        zod?.bag?.description ??
        def.description ??
        "";
    const typeName = def.type;
    switch (typeName) {
        case "string":
            return description || "string";
        case "number":
            return 0;
        case "boolean":
            return false;
        case "array": {
            const inner = def.element;
            if (inner && typeof inner === "object")
                return [zodFieldToExample(inner)];
            return ["value"];
        }
        case "enum": {
            if (Array.isArray(def.values))
                return def.values[0] ?? "enum";
            if (def.entries && typeof def.entries === "object") {
                const keys = Object.keys(def.entries);
                return keys[0] ?? "enum";
            }
            return "enum";
        }
        case "object": {
            const shape = anyField.shape;
            if (!shape)
                return {};
            /** @type {Record<string, unknown>} */
            const obj = {};
            for (const [key, value] of Object.entries(shape)) {
                obj[key] = zodFieldToExample(value);
            }
            return obj;
        }
        case "nullable":
            return def.innerType ? zodFieldToExample(def.innerType) : null;
        case "optional":
            return def.innerType ? zodFieldToExample(def.innerType) : undefined;
        case "default":
        case "prefault": {
            // Prefer the concrete default so the agent sees a valid value; fall
            // back to the wrapped type's shape when no default is present.
            if ("defaultValue" in def && def.defaultValue !== undefined)
                return def.defaultValue;
            return def.innerType ? zodFieldToExample(def.innerType) : "value";
        }
        case "literal": {
            if (Array.isArray(def.values) && def.values.length > 0)
                return def.values[0];
            return "value";
        }
        default:
            return description || "value";
    }
}
