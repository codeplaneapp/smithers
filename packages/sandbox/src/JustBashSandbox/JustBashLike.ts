/**
 * The structural slice of a just-bash interpreter.
 *
 * @since 0.1.0
 */

/**
 * The per-call options this provider passes to `exec`: the subset of
 * just-bash's `ExecOptions` (`dist/Bash.d.ts`, `interface ExecOptions`) the
 * session contract needs.
 *
 * The field meanings are just-bash's own. `env` is merged into the
 * interpreter's current environment for this one call and restored
 * afterwards; the provider never asks for `replaceEnv`. `cwd` is the working
 * directory for this one call. `stdin` is the command's standard input as a
 * string, and `stdinKind: "bytes"` tells the interpreter the string is a
 * latin1 byte buffer, one character per byte, to forward verbatim.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashExecOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdin?: string
  readonly stdinKind?: "text" | "bytes"
}

/**
 * The fields of a just-bash `BashExecResult` (`dist/types.d.ts`,
 * `interface ExecResult`) this provider reads. The real result also carries
 * the final environment and optional metadata, which the session contract
 * has no place for.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * The part of a `just-bash` interpreter instance this provider uses.
 *
 * Satisfied by the `Bash` class of the `just-bash` npm package, whose method
 * is `exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>`
 * (3.2.0, `dist/Bash.d.ts`). The caller constructs the real interpreter and
 * mounts it over the same filesystem passed to `JustBashSandbox.make`.
 * Keeping the SDK structural leaves `just-bash` optional and keeps this
 * package browser-safe.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashLike {
  /** Runs one command line to completion and returns its captured result. */
  readonly exec: (commandLine: string, options?: JustBashExecOptions) => Promise<JustBashExecResult>
}
