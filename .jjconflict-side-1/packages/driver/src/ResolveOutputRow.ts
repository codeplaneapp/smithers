import type { z } from "zod";

/**
 * Resolve the row type a `ctx.output`/`ctx.outputMaybe`/`ctx.latest` call returns
 * from the `table` argument it was given:
 *
 * - a string table name (a key of the workflow Schema) → the inferred row for
 *   that registered schema (`outputs.X` keyed by name);
 * - a Zod schema object (e.g. `outputs.research`) → `z.infer` of that schema;
 * - a Drizzle table (carries `$inferSelect`) → its select row;
 * - anything else (a widened `string`, `unknown`) → an untyped output row.
 *
 * This is what makes `ctx.outputMaybe(outputs.research, ...)` carry the research
 * fields instead of an untyped `Record<string, unknown>`.
 */
export type ResolveOutputRow<Schema, T> = T extends keyof Schema
	? Schema[T] extends z.ZodTypeAny
		? z.infer<Schema[T]>
		: Schema[T] extends { $inferSelect: infer R }
			? R
			: Record<string, unknown>
	: T extends z.ZodTypeAny
		? z.infer<T>
		: T extends { $inferSelect: infer R }
			? R
			: Record<string, unknown>;
