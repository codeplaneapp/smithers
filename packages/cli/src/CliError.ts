/**
 * Failures owned by the command-line projection.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * A malformed command-line invocation.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class UsageError extends Schema.TaggedError<UsageError>()("/cli/UsageError", {
  message: Schema.String
}) {}

/**
 * A command that the selected projection cannot perform.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()("/cli/UnsupportedError", {
  message: Schema.String
}) {}

/**
 * Every failure introduced by the CLI projection.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CliError = UsageError | UnsupportedError

/**
 * Maps a CLI-level failure to its stable process exit status.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const exitCode = (error: CliError): number => error._tag === "/cli/UsageError" ? 2 : 1
