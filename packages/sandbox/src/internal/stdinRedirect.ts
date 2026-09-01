/**
 * Delivers standard input through a workspace file for transports without an
 * input channel.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"

/**
 * The slice of a session the redirect needs: somewhere to put the bytes, and
 * a way to take them away again.
 *
 * @category models
 * @since 0.1.0
 */
export interface StdinTarget {
  readonly workdir: string
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, ProviderError>
  /**
   * Removes one staged file. Runs as a finalizer of the spawn's scope, so a
   * command that was killed, interrupted, or never reached its own cleanup
   * does not leave the caller's input on the machine.
   */
  readonly remove: (path: string) => Effect.Effect<void, ProviderError>
}

/** The session-private directory staged input lives in, below the workspace. */
const stagingDirectory = ".smthrs-stdin"

/**
 * An unguessable file name.
 *
 * A per-session counter was not one. It reset on every acquire, so a
 * reattached machine — a resumed Vercel sandbox, an adopted ECS task, a
 * leftover container — started again at `.smthrs-stdin-0` and could read or
 * overwrite the previous incarnation's staged input. Standard input is where a
 * caller puts a script, a patch, or a credential blob.
 */
const staged = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Builds a per-session redirect: hands back a function that stages a
 * command's standard input as a file and rewrites the command to read from
 * it.
 *
 * Most vendor execution APIs take a command line and nothing else, so the
 * only way to satisfy the session contract's "spawn delivers stdin" is to put
 * the bytes where the command can reach them: a file in the workspace, read
 * through an ordinary redirection.
 *
 * The file's lifetime is the spawn's scope, not the command's own good
 * behavior. Removal used to be a `rm` appended to the rewritten command line,
 * which is exactly the cleanup a kill or an interruption skips: the wrapper
 * shell died with the command and the bytes stayed on the machine. It is a
 * scoped resource instead, so the removal runs on success, failure, kill, and
 * interruption alike.
 *
 * The rewritten line is `( command ) < file`, which keeps the command's own
 * exit status and its own quoting: the command text is placed inside a
 * subshell verbatim, so a caller's pipeline or compound command means what it
 * meant.
 *
 * @category constructors
 * @since 0.1.0
 */
export const stdinRedirect = (target: StdinTarget): (
  command: string,
  stdin: Uint8Array | undefined
) => Effect.Effect<string, ProviderError, Scope.Scope> => {
  const directory = `${target.workdir.replace(/\/+$/, "")}/${stagingDirectory}`
  return (command, stdin) => {
    if (stdin === undefined) return Effect.succeed(command)
    return Effect.gen(function*() {
      const file = `${directory}/${staged()}`
      yield* Effect.acquireRelease(
        target.writeFile(file, stdin),
        () => Effect.ignore(target.remove(file), { log: "Warn" })
      )
      return `( ${command} ) < ${CommandLine.quote(file)}`
    })
  }
}
