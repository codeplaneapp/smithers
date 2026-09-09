import { spawn } from "node:child_process"

/**
 * Runs a subprocess under a deadline the caller can enforce, resolving with its
 * combined stdout and stderr.
 *
 * `execFileSync` blocks the worker's event loop, so Vitest's `testTimeout`
 * timer never gets to run while a child is wedged and the enclosing budget
 * bounds nothing. Awaiting an asynchronous child leaves the loop free to fire
 * the deadline. The child also gets its own process group so expiry kills the
 * whole tree: a build script's nested compiler would otherwise outlive the
 * script and hold the pipes open past the kill.
 */
export const runWithDeadline = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly timeoutMs: number }
): Promise<string> =>
  new Promise((resolve, reject) => {
    const label = [command, ...args].join(" ")
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    })

    let output = ""
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8")
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    let expired = false
    const deadline = setTimeout(() => {
      expired = true
      const pid = child.pid
      try {
        // A negative pid signals the group, so descendants die with the child.
        if (pid === undefined) child.kill("SIGKILL")
        else process.kill(-pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, options.timeoutMs)

    child.on("error", (cause) => {
      clearTimeout(deadline)
      reject(cause)
    })
    child.on("close", (code, signal) => {
      clearTimeout(deadline)
      if (expired) reject(new Error(`${label} exceeded its ${options.timeoutMs} ms deadline\n${output}`))
      else if (code === 0) resolve(output)
      else reject(new Error(`${label} exited with ${signal ?? code}\n${output}`))
    })
  })
