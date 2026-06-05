/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. Structured output object nodes must set `additionalProperties: false`.
 *
 * Zod v4's `toJSONSchema()` can violate these rules when loose/passthrough
 * objects are used. Codex rejects those schemas unless they are strict.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 */
export function sanitizeForOpenAI(node) {
    if (node == null || typeof node !== "object")
        return;
    const obj = node;
    // Rule 1: If a node has `additionalProperties`, it must also have
    // `"type": "object"`. Zod can omit `type` on passthrough objects.
    if ("additionalProperties" in obj && !("type" in obj)) {
        obj.type = "object";
    }
    // Rule 2: Codex/OpenAI structured outputs require strict object schemas.
    if (obj.type === "object" && obj.additionalProperties !== false) {
        obj.additionalProperties = false;
    }
    // Recurse into all sub-schemas
    for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
            for (const item of value)
                sanitizeForOpenAI(item);
        }
        else if (typeof value === "object" && value !== null) {
            sanitizeForOpenAI(value);
        }
    }
}
