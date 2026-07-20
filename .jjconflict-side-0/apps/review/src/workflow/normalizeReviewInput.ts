import { reviewInputSchema, type ReviewInput } from "./reviewInputSchema";

/**
 * ctx.input fields arrive as null (not as zod defaults) for keys the caller
 * omitted, so strip nulls before parsing to let the defaults apply.
 */
export function normalizeReviewInput(value: unknown): ReviewInput {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return reviewInputSchema.parse(record);
}
