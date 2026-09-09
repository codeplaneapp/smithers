/**
 * Runs `node` synchronously with a finite budget.
 *
 * Every synchronous child blocks the worker's event loop, so the enclosing
 * Vitest timeout cannot fire while the child is stuck and cannot kill it
 * either. The `timeout` here is the bound that actually applies, and
 * `SIGKILL` is what makes it hold for a child wedged inside a native call.
 *
 * A child the budget kills also ends with `signal: "SIGKILL"` and a `null`
 * status, which is exactly what a fixture that dies on purpose reports, so the
 * spawn error is checked here and rethrown with everything the child left
 * behind rather than handed back for the caller to mistake for a real result.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))

export const spawnBounded = (args: ReadonlyArray<string>, timeout: number) => {
  const result = spawnSync(process.execPath, [...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL"
  })
  if (result.error !== undefined) {
    throw new Error(
      `node ${args.join(" ")} did not finish within ${timeout} ms: ${result.error.message}` +
        ` (status ${result.status}, signal ${result.signal})\n${result.stderr}`,
      { cause: result.error }
    )
  }
  return result
}
