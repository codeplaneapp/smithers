/**
 * Sanitize a JSON Schema for OpenAI's structured-output API.
 *
 * OpenAI's `response_format` imposes constraints beyond standard JSON Schema:
 *
 * 1. Every object node **must** include `"type": "object"`.
 * 2. Structured output object nodes must set `additionalProperties: false`.
 * 3. When `additionalProperties: false`, every key in `properties` must also
 *    appear in `required` (strict mode treats all listed properties as
 *    required; truly-optional fields should be modeled as nullable).
 *
 * Zod v4's `toJSONSchema()` can violate these rules when loose/passthrough
 * objects are used. Codex rejects those schemas unless they are strict.
 *
 * This function fixes these issues in-place so any agent (Codex, future
 * OpenAI-backed agents, etc.) can safely use a JSON Schema for OpenAI.
 *
 * @param {unknown} node - JSON Schema node; mutated in place.
 * @returns {void}
 */
export function sanitizeForOpenAI(node) {
  if (node == null || typeof node !== "object") return;
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
  // Rule 3: With `additionalProperties: false`, OpenAI strict mode requires
  // every key in `properties` to also appear in `required`. Zod omits
  // optional fields from `required`, which strict mode rejects. List all
  // property keys (truly-optional fields should be modeled as nullable).
  if (obj.additionalProperties === false && obj.properties != null && typeof obj.properties === "object") {
    obj.required = Object.keys(obj.properties);
  }
  // Recurse into all sub-schemas
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) sanitizeForOpenAI(item);
    } else if (typeof value === "object" && value !== null) {
      sanitizeForOpenAI(value);
    }
  }
}
