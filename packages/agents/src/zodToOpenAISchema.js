import { assertZodV4 } from "@smithers-orchestrator/errors/assertZodV4";
import { sanitizeForOpenAI } from "./sanitizeForOpenAI.js";
/**
 * Convert a Zod schema to an OpenAI-safe JSON Schema object.
 *
 * Usage:
 * ```ts
 * import { zodToOpenAISchema } from "./zodToOpenAISchema";
 * const jsonSchema = zodToOpenAISchema(myZodSchema);
 * ```
 *
 * @param {import("zod").ZodTypeAny} zodSchema
 * @returns {Promise<Record<string, unknown>>}
 */
export async function zodToOpenAISchema(zodSchema) {
    // z.toJSONSchema() reads Zod v4 internals; a v3 schema throws a cryptic
    // `schema._zod.def` TypeError. Surface a clear, actionable error instead.
    assertZodV4(zodSchema);
    const { z } = await import("zod");
    const jsonSchema = z.toJSONSchema(zodSchema, { unrepresentable: "any" });
    sanitizeForOpenAI(jsonSchema);
    return jsonSchema;
}
