import { z } from "zod";

const schemaSymbol = Symbol.for("smithers.tool.schema");

/** @param {import("zod").ZodTypeAny} schema */
export const zodSchema = (schema) => ({
  [schemaSymbol]: true,
  _type: undefined,
  jsonSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
  validate: async (value) => {
    const result = await schema.safeParseAsync(value);
    return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
  },
});
/** @template T @param {T} definition @returns {T} */
export const tool = (definition) => definition;
