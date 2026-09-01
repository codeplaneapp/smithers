/**
 * Delivers standard input through a workspace file for transports without an
 * input channel.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * The slice of a session the redirect needs: somewhere to put the bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface StdinTarget {
  readonly workdir: string
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, ProviderError>
}

/**
 * Builds a per-session redirect: hands back a function that stages a
 * command's standard input as a file and rewrites the command to read from
 * it.
 *
 * Most vendor execution APIs take a command line and nothing else, so the
 * only way to satisfy the session contract's "spawn delivers stdin" is to put
 * the bytes where the command can reach them: a file in the workspace, read
 * through an ordinary redirection, removed once the command ends whatever its
 * status. The file name carries a per-session counter so concurrent commands
 * in one session do not overwrite each other's input.
 *
 * The rewritten line is `( command ) < file; s=$?; rm -f file; exit $s`, which
 * keeps the command's own exit status and its own quoting: the command text is
 * placed inside a subshell verbatim, so a caller's pipeline or compound
 * command means what it meant.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stdinRedirect = (target: StdinTarget): (
  command: string,
  stdin: Uint8Array | undefined
) => Effect.Effect<string, ProviderError> => {
  let next = 0
  return (command, stdin) => {
    if (stdin === undefined) return Effect.succeed(command)
    const file = `${target.workdir.replace(/\/+$/, "")}/.smthrs-stdin-${next++}`
    const quoted = CommandLine.quote(file)
    return Effect.as(
      target.writeFile(file, stdin),
      `( ${command} ) < ${quoted}; s=$?; rm -f ${quoted}; exit $s`
    )
  }
}
