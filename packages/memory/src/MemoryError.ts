/**
 * Stable memory failures.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable codes returned by memory operations.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const MemoryErrorCode = Schema.Literals([
  "not_found",
  "fts_not_enabled",
  "invalid_namespace",
  "invalid_tag",
  "supersede_conflict",
  "embedding_unavailable",
  "store"
])

/**
 * Stable memory failure code.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type MemoryErrorCode = typeof MemoryErrorCode.Type

/**
 * Error raised by memory validation, storage, search, or projection.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class MemoryError extends Schema.TaggedError<MemoryError>()("flows/memory/MemoryError", {
  code: MemoryErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
