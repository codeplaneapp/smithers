/**
 * The structural slice of a just-bash interpreter.
 *
 * @since 0.1.0
 */

/**
 * The slice of a `just-bash` interpreter instance this module depends on.
 *
 * Satisfied by the `Bash` class exported from the **`just-bash`** npm package
 * (`new Bash({ fs })`), whose method is
 * `exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>`
 * (3.2.0, `dist/Bash.d.ts`). Only the members this adapter touches are
 * declared, under their real names: `cwd` and `env` from `ExecOptions`, and
 * `stdout`/`stderr`/`exitCode` from the result. The real `ExecOptions` also
 * carries a string `stdin` and an abort `signal`; the adapter does not use
 * them yet.
 *
 * We take an instance rather than the package so the browser bundle owns
 * construction — mounting the interpreter on the *same* virtual filesystem
 * `BrowserFileSystem` adapts — and so tests can hand us a stub.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface JustBashLike {
  /** Run a command line to completion through the interpreter and return its captured result. */
  readonly exec: (
    commandLine: string,
    options?: { readonly cwd?: string; readonly env?: Record<string, string> }
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}
