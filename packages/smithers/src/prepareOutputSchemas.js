/**
 * Duplicate schema objects need distinct output refs so Task `output={outputs.foo}`
 * can still resolve the intended table by identity.
 * @param {Record<string, any>} schemas
 */
export function prepareOutputSchemas(schemas) {
    const counts = new Map();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        counts.set(zodSchema, (counts.get(zodSchema) ?? 0) + 1);
    }
    const outputs = {
        ...schemas,
    };
    const zodToKeyName = new Map();
    const ambiguousZodSchemas = new Set();
    for (const [name, zodSchema] of Object.entries(schemas)) {
        if (name === "input")
            continue;
        if ((counts.get(zodSchema) ?? 0) > 1) {
            ambiguousZodSchemas.add(zodSchema);
            const aliasSchema = zodSchema.clone();
            outputs[name] = aliasSchema;
            zodToKeyName.set(aliasSchema, name);
            continue;
        }
        zodToKeyName.set(zodSchema, name);
    }
    return {
        outputs,
        zodToKeyName,
        ambiguousZodSchemas,
    };
}
