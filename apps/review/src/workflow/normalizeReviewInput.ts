/**
 * Decodes a caller-supplied review request.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import { ReviewInput } from "./reviewInputSchema.ts";

const decode = Schema.decodeUnknownSync(ReviewInput);

/**
 * Decodes a review request, letting the declared defaults apply to keys the
 * caller omitted.
 *
 * Callers hand this JSON that came off a command line, a GitHub Action input,
 * or a flow payload, and those sources spell "not supplied" as an explicit
 * `null` at least as often as by leaving the key out. Stripping nulls first is
 * what makes both spellings mean the same thing.
 *
 * @since 1.0.0
 * @category constructors
 */
export function normalizeReviewInput(value: unknown): ReviewInput {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return decode(record);
}
