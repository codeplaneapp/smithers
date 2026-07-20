/** @typedef {"string" | "number" | "boolean" | "object" | "array" | "null" | "unknown"} OutputSchemaFieldType */
/** @typedef {{ name: string; type: OutputSchemaFieldType; optional: boolean; nullable: boolean; description?: string; enum?: readonly unknown[]; }} OutputSchemaFieldDescriptor */
/** @typedef {{ fields: OutputSchemaFieldDescriptor[]; }} OutputSchemaDescriptor */
/** @typedef {{ code: "SchemaConversionError"; field: string; construct: string; message: string; }} OutputSchemaDescriptorWarning */

/**
 * @param {{ shape?: Record<string, unknown> } & Record<string, unknown>} schema
 * @param {{ onWarning?: (warning: OutputSchemaDescriptorWarning) => void }} [options]
 * @returns {OutputSchemaDescriptor}
 */
export function buildOutputSchemaDescriptor(schema, options = {}) {
    const shape = schema?.shape;
    if (!shape || typeof shape !== "object" || Array.isArray(shape)) {
        throw new Error("Output schema descriptor requires a Zod object schema.");
    }
    /** @type {OutputSchemaFieldDescriptor[]} */
    const fields = [];
    for (const [name, fieldSchema] of Object.entries(shape)) {
        fields.push(describeField(name, fieldSchema, options));
    }
    return { fields };
}
/**
 * @param {string} name
 * @param {unknown} schema
 * @param {{ onWarning?: (warning: OutputSchemaDescriptorWarning) => void }} options
 * @returns {OutputSchemaFieldDescriptor}
 */
function describeField(name, schema, options) {
    const unwrapped = unwrapSchema(schema);
    const schemaRecord = /** @type {{ description?: unknown } | null | undefined} */ (schema && typeof schema === "object" ? schema : null);
    const innerRecord = /** @type {{ description?: unknown } | null | undefined} */ (unwrapped.schema && typeof unwrapped.schema === "object" ? unwrapped.schema : null);
    const description = asOptionalString(schemaRecord?.description) ?? asOptionalString(innerRecord?.description);
    const base = describeUnwrappedType(name, unwrapped.schema, options);
    /** @type {OutputSchemaFieldDescriptor} */
    const field = {
        name,
        type: base.type,
        optional: unwrapped.optional,
        nullable: unwrapped.nullable,
    };
    if (description) field.description = description;
    if (base.description) field.description = field.description ?? base.description;
    if (base.enumValues) field.enum = base.enumValues;
    return field;
}
/**
 * @param {unknown} schema
 * @returns {{ schema: unknown; optional: boolean; nullable: boolean }}
 */
function unwrapSchema(schema) {
    /** @type {unknown} */
    let current = schema;
    let optional = false;
    let nullable = false;
    let guard = 0;
    /**
     * @param {unknown} value
     * @returns {Record<string, unknown> | undefined}
     */
    const getDef = (value) => {
        if (!value || typeof value !== "object") return undefined;
        const inner = /** @type {{ _zod?: { def?: Record<string, unknown> } }} */ (value);
        return inner._zod?.def;
    };
    let def = getDef(current);
    while (def && guard < 32) {
        guard += 1;
        switch (def?.type) {
            case "optional":
                optional = true;
                current = def.innerType;
                break;
            case "default":
                optional = true;
                current = def.innerType;
                break;
            case "nullable":
                nullable = true;
                current = def.innerType;
                break;
            case "readonly":
            case "nonoptional":
            case "catch":
                current = def.innerType;
                break;
            case "pipe":
                current = def.out ?? def.in ?? current;
                break;
            default:
                return { schema: current, optional, nullable };
        }
        def = getDef(current);
    }
    return { schema: current, optional, nullable };
}
/**
 * @param {string} field
 * @param {unknown} schema
 * @param {{ onWarning?: (warning: OutputSchemaDescriptorWarning) => void }} options
 * @returns {{ type: OutputSchemaFieldType; enumValues?: readonly unknown[]; description?: string; }}
 */
function describeUnwrappedType(field, schema, options) {
    const def = /** @type {Record<string, unknown> | undefined} */ (schema && typeof schema === "object" ? /** @type {{ _zod?: { def?: Record<string, unknown> } }} */ (schema)._zod?.def : undefined);
    const typeName = asOptionalString(def?.type) ?? "unknown";
    switch (typeName) {
        case "string": return { type: "string" };
        case "number":
        case "int":
        case "float": return { type: "number" };
        case "boolean": return { type: "boolean" };
        case "null": return { type: "null" };
        case "array":
        case "tuple":
        case "set": return { type: "array" };
        case "object": return { type: "object" };
        case "record": return { type: "object", description: "Record value shape is not expanded in v1." };
        case "map": return { type: "object", description: "Map entries are not expanded in v1." };
        case "enum": {
            const entries = def?.entries;
            const enumValues = entries && typeof entries === "object" ? Object.values(entries) : [];
            return { type: "string", ...(enumValues.length > 0 ? { enumValues } : {}) };
        }
        case "literal": {
            const values = Array.isArray(def?.values) ? def.values : [];
            if (values.length === 1 && values[0] === null) return { type: "null" };
            if (values.length === 1 && typeof values[0] === "string") return { type: "string", enumValues: values };
            if (values.length === 1 && typeof values[0] === "number") return { type: "number", enumValues: values };
            if (values.length === 1 && typeof values[0] === "boolean") return { type: "boolean", enumValues: values };
            reportUnsupported(field, typeName, options);
            return { type: "unknown" };
        }
        case "unknown":
        case "any":
        case "void":
        case "undefined":
        case "never": return { type: "unknown" };
        default:
            reportUnsupported(field, typeName, options);
            return { type: "unknown" };
    }
}
/**
 * @param {string} field
 * @param {string} construct
 * @param {{ onWarning?: (warning: OutputSchemaDescriptorWarning) => void }} options
 * @returns {void}
 */
function reportUnsupported(field, construct, options) {
    options.onWarning?.({
        code: "SchemaConversionError",
        field,
        construct,
        message: `Unsupported schema construct "${construct}" in output field "${field}".`,
    });
}
/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asOptionalString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
