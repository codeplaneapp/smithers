/**
 * The structural slice of a just-bash interpreter.
 *
 * @since 0.1.0
 */

/**
 * The slice of a `just-bash` interpreter instance this module depends on.
 *
 * Satisfied by the `Bash` class exported from the **`just-bash`** npm package
 * (`new Bash({ fs })`). We take an instance rather than the package so the
 * browser bundle owns construction — mounting the interpreter on the *same*
 * virtual filesystem `BrowserFileSystem` adapts — and so tests can hand
 * us a stub.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface JustBashLike {
  /** Run a command line through the interpreter and return its captured result. */
  readonly run: (
    command: string,
    opts?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}
