
/** @typedef {import("zod").ZodObject<import("zod").ZodRawShape>} ZodObject */
/** @typedef {import("zod").ZodTypeAny} ZodTypeAny */
/**
 * @param {ZodObject} schema
 * @returns {string}
 */
export function zodSchemaToJsonExample(schema) {
    const state = { depth: 0, active: new WeakSet() };
    /** @type {Record<string, unknown>} */
    const example = {};
    for (const [key, field] of Object.entries(schema.shape)) {
        example[key] = zodFieldToExample(/** @type {ZodTypeAny} */ (field), state);
    }
    return JSON.stringify(example, null, 2);
}

const MAX_EXAMPLE_DEPTH = 12;

/**
 * @typedef {{ depth: number; active: WeakSet<object> }} ExampleState
 */

/**
 * @param {ZodTypeAny} field
 * @param {ExampleState} state
 * @returns {unknown}
 */
function zodFieldToExample(field, state) {
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
                options?: ZodTypeAny[];
                getter?: () => ZodTypeAny;
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
    if (state.depth >= MAX_EXAMPLE_DEPTH || state.active.has(/** @type {object} */ (field)))
        return description || "value";
    const nextState = { depth: state.depth + 1, active: state.active };
    state.active.add(/** @type {object} */ (field));
    const typeName = def.type;
    try {
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
                    return [zodFieldToExample(inner, nextState)];
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
                    obj[key] = zodFieldToExample(value, nextState);
                }
                return obj;
            }
            case "nullable":
                return def.innerType ? zodFieldToExample(def.innerType, nextState) : null;
            case "optional":
                return def.innerType ? zodFieldToExample(def.innerType, nextState) : undefined;
            case "default":
            case "prefault": {
                // Prefer the concrete default so the agent sees a valid value;
                // fall back to the wrapped type's shape when none is present.
                if ("defaultValue" in def && def.defaultValue !== undefined)
                    return def.defaultValue;
                return def.innerType ? zodFieldToExample(def.innerType, nextState) : "value";
            }
            case "literal": {
                if (Array.isArray(def.values) && def.values.length > 0)
                    return def.values[0];
                return "value";
            }
            case "union": {
                // Zod discriminated unions use the same ordered options array.
                // Choosing the first branch keeps examples deterministic while
                // still exposing the complete nested envelope shape.
                const option = Array.isArray(def.options) ? def.options[0] : undefined;
                return option ? zodFieldToExample(option, nextState) : description || "value";
            }
            case "lazy": {
                if (typeof def.getter !== "function")
                    return description || "value";
                const inner = def.getter();
                return inner ? zodFieldToExample(inner, nextState) : description || "value";
            }
            default:
                return description || "value";
        }
    }
    finally {
        state.active.delete(/** @type {object} */ (field));
    }
}
