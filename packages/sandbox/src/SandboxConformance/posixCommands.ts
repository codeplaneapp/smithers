/**
 * Default conformance commands for POSIX-shell sessions.
 *
 * @since 0.1.0
 */
import type { Commands } from "../ProviderConformance/Commands.ts"

/**
 * The provider-conformance command fixture every POSIX-shell session can run.
 *
 * The session contract already pins command lines to POSIX `sh` semantics, so
 * unlike the spawner-level suite, this one can supply its own fixture; a
 * session whose machine speaks something else overrides it.
 *
 * @category models
 * @since 0.1.0
 */
export const posixCommands: Commands = {
  writes: "printf 'sandbox conformance'",
  output: "sandbox conformance",
  fails: "exit 23",
  failureCode: 23,
  runs: "sleep 60",
  shell: true
}
