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
 * `runs` sleeps for a duration nothing else on a shared machine is likely to
 * be sleeping for, and `survivor` looks for exactly that sleep with a pattern
 * that cannot match its own command line. A guest without `pgrep` answers 127
 * and the survivor question goes unanswered rather than wrongly answered.
 *
 * @category models
 * @since 0.1.0
 */
export const posixCommands: Commands = {
  writes: "printf 'sandbox conformance'",
  output: "sandbox conformance",
  fails: "exit 23",
  failureCode: 23,
  runs: "sleep 3607",
  survivor: "pgrep -f 'sleep 360[7]'",
  shell: true
}
