/**
 * The single typed error returned by the file-routing surfaces.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Stable failure codes for routing, parsing, loading, and decoding.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Code = Schema.Literals([
  "discovery_failed",
  "parse_failed",
  "unknown_command",
  "ambiguous_command",
  "duplicate_route",
  "load_failed",
  "unsupported_body",
  "unsupported_schema",
  "decode_failed",
  "encode_failed"
])

/**
 * Stable failure codes for routing, parsing, loading, and decoding.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Code = typeof Code.Type

/**
 * A recoverable file-routing failure.
 *
 * `method` names the surface that failed so a CLI or an agent can report the
 * origin without a stack trace.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class FsError extends Schema.TaggedError<FsError>()("flows/fs/FsError", {
  code: Code,
  method: Schema.String,
  description: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
