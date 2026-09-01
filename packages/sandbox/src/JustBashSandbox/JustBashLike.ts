/**
 * The structural slice of a just-bash interpreter.
 *
 * @since 0.1.0
 */

/**
 * The part of a `just-bash` interpreter instance this provider uses.
 *
 * The caller constructs the real interpreter and mounts it over the same
 * filesystem passed to `JustBashSandbox.make`. Keeping the SDK structural
 * leaves `just-bash` optional and keeps this package browser-safe.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashLike {
  /** Runs one command line to completion and returns its captured result. */
  readonly run: (
    command: string,
    options?: {
      readonly cwd?: string | undefined
      readonly env?: Readonly<Record<string, string>> | undefined
    }
  ) => Promise<{
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number
  }>
}
