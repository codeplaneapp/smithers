/**
 * The smthrs process entry, as a function.
 *
 * `main.js` boots the TypeScript loader and `main.ts` calls {@link main}
 * with the real process. Everything the process does beyond that, capturing
 * and clearing the cache credentials, wiring SIGINT and SIGTERM to one
 * `AbortController`, recording the exit code, lives here so a test can drive
 * it with a fake process and a fake terminal.
 *
 * @since 0.1.0
 */
import { makeCli, normalizeArgv } from "./Cli.ts"
import type * as Reporter from "./Reporter.ts"

/**
 * The slice of `process` the entry point touches.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly stdout: Reporter.Terminal
  readonly stderr: Reporter.Terminal
  readonly once: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly removeListener: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void
  readonly setExitCode: (code: number) => void
}

/**
 * Runs one invocation against a host. The cache URL and token are read once
 * and removed from the host environment before any BUILD.ts evaluates, so no
 * workspace module can read them. A signal aborts every running target and
 * the process exits 1 whatever the command was about to report.
 *
 * @category execution
 * @since 0.1.0
 */
export const main = async (host: Host): Promise<void> => {
  const cacheUrl = host.env["SMITHERS_CACHE_URL"]
  const cacheToken = host.env["SMITHERS_CACHE_TOKEN"]
  delete host.env["SMITHERS_CACHE_URL"]
  delete host.env["SMITHERS_CACHE_TOKEN"]

  const controller = new AbortController()
  let interrupted = false
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    interrupted = true
    host.setExitCode(1)
    controller.abort(new Error(`smithers build interrupted by ${signal}`))
  }
  const onSigint = (): void => interrupt("SIGINT")
  const onSigterm = (): void => interrupt("SIGTERM")
  const exit = (code: number): void => host.setExitCode(code)

  host.once("SIGINT", onSigint)
  host.once("SIGTERM", onSigterm)
  try {
    await makeCli({
      cacheUrl,
      cacheToken,
      signal: controller.signal,
      environment: host.env,
      stdout: host.stdout,
      stderr: host.stderr,
      exit
    }).serve([...normalizeArgv(host.argv)], { exit, stdout: (text) => host.stdout.write(text) })
  } finally {
    host.removeListener("SIGINT", onSigint)
    host.removeListener("SIGTERM", onSigterm)
    if (interrupted) host.setExitCode(1)
  }
}
