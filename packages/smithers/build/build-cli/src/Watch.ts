/** Dependency-aware execution in fresh processes, with cancellation on file changes.
 * @since 0.1.0
 */
import { watch } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as ContainedProcess from "./internal/ContainedProcess.ts"

/** Runs fresh CLI processes until interrupted, cancelling stale work when an input changes.
 * @category execution
 * @since 0.1.0
 */
export const run = async (options: {
  readonly root: string
  readonly args: ReadonlyArray<string>
  readonly ignored: ReadonlyArray<string>
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly debounceMs: number
  readonly once: boolean
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly cycleCompleted?:
    | ((cycle: {
      readonly number: number
      readonly exitCode: number
      readonly output: string
    }) => void)
    | undefined
}) => {
  options.signal?.throwIfAborted()
  // The package bootstrap installs declaration identity hooks before importing
  // any command modules, both in a checkout and in a compiled distribution.
  const manifest = createRequire(import.meta.url).resolve("@smthrs/build-cli/package.json")
  const entry = fileURLToPath(new URL("./src/main.js", pathToFileURL(manifest)))
  const ignored = [".git", "node_modules", ...options.ignored].map((path) =>
    path.replaceAll("\\", "/").replace(/\/$/, "")
  )
  let revision = 0
  let cycles = 0
  let exitCode = 0
  let notify = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopChild = () => {}
  const watcher = options.once ? undefined : watch(options.root, { recursive: true }, (_event, filename) => {
    if (filename === null) return
    const path = filename.toString().replaceAll("\\", "/")
    if (
      path.split("/").includes("node_modules") ||
      ignored.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    ) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      revision += 1
      stopChild()
      notify()
    }, options.debounceMs)
  })
  let watchError: Error | undefined
  watcher?.on("error", (error) => {
    watchError = error
    stopChild()
    notify()
  })
  const abort = () => {
    stopChild()
    notify()
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    while (!options.signal?.aborted && watchError === undefined) {
      const startedAt = revision
      cycles += 1
      const controller = new AbortController()
      stopChild = () => controller.abort()
      let output = ""
      try {
        exitCode = await ContainedProcess.run({
          command: process.execPath,
          args: [entry, ...options.args, "--workspace", options.root],
          cwd: options.root,
          environment: options.environment,
          signal: controller.signal,
          stdout: (text) => {
            if (options.cycleCompleted !== undefined) output = `${output}${text}`.slice(-16 * 1024)
            options.stdout(text)
          },
          stderr: options.stderr
        })
      } catch (cause) {
        if (!(cause instanceof ContainedProcess.ProcessError) || cause.code !== "cancelled") throw cause
        exitCode = 1
      } finally {
        stopChild = () => {}
      }
      options.cycleCompleted?.({ number: cycles, exitCode, output })
      if (options.once) break
      if (startedAt === revision && !options.signal?.aborted && watchError === undefined) {
        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    }
    if (watchError !== undefined) throw watchError
    return { cycles, exitCode, stopped: options.signal?.aborted ?? false }
  } finally {
    clearTimeout(timer)
    watcher?.close()
    options.signal?.removeEventListener("abort", abort)
    stopChild()
  }
}
