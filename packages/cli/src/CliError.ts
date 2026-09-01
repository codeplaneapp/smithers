/**
 * Failures owned by the command-line projection.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * The operator spelled the invocation wrong: an unparseable flag value, a
 * payload that does not match its schema, an argument outside the accepted
 * set.
 *
 * Raise this when the fix is to retype the command. The message is printed as
 * written, so it must name the flag or argument at fault, the value received,
 * and the accepted form. It carries no cause: a usage error is about the
 * invocation, not about anything that failed underneath it.
 *
 * Exits 2.
 *
 * @category errors
 * @since 0.1.0
 */
export class UsageError extends Schema.TaggedError<UsageError>()("/cli/UsageError", {
  message: Schema.String
}) {}

/**
 * The invocation was spelled correctly and this projection cannot perform it:
 * a verb or flag removed in 1.0.0-rc.0, a reserved system flow, or a local-only
 * operation asked of a `--remote` composition.
 *
 * Raise this when retyping the command cannot help and the operator needs to
 * be told what replaced the thing they asked for. rc-contract section 4.2
 * fixes the wording of the removal messages, so prefer the constructors in
 * `Unsupported` over a hand-written sentence.
 *
 * Exits 1.
 *
 * @category errors
 * @since 0.1.0
 */
export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()("/cli/UnsupportedError", {
  message: Schema.String
}) {}

/**
 * Every failure the command-line projection adds on top of the control
 * plane's own.
 *
 * A handler's error channel carries these beside the typed control-plane
 * failures; `bin.ts` prints both and this union decides the exit status.
 *
 * @category models
 * @since 0.1.0
 */
export type CliError = UsageError | UnsupportedError

/**
 * The process exit status one CLI failure ends on.
 *
 * The two codes are part of the released contract, so a script can branch on
 * them: 2 means the operator can fix the command line, 1 means they cannot.
 * Statuses 3, 130, and 143 belong to run outcomes rather than to failures and
 * come from `Output.exitCode` instead.
 *
 * @category getters
 * @since 0.1.0
 */
export const exitCode = (error: CliError): number => error._tag === "/cli/UsageError" ? 2 : 1
