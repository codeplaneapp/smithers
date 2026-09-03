/**
 * A sandbox runtime a fault suite can stop, kill, and revive for real.
 *
 * `@smthrs/sandbox`'s `SandboxHealth` classifies liveness from one ping, and
 * the two unhealthy reasons it reports are meaningfully different: a ping that
 * fails is `ping_failed`, and a ping that never answers is `unresponsive`. A
 * fake provider can return either on request, which proves nothing. This
 * harness puts a real child process behind the ping instead, so `SIGSTOP`
 * produces `unresponsive` and a dead process produces `ping_failed` because
 * that is what actually happened to the sandbox.
 *
 * @since 1.0.0
 */
import type { SandboxHealth } from "@smthrs/sandbox"
import { RemoteChildProcessSpawner } from "@smthrs/sandbox"
import { killProcess } from "@smthrs/testing/Faults"
import * as Effect from "effect/Effect"
import { type ChildProcess, spawn } from "node:child_process"
import { connect } from "node:net"
import { fileURLToPath } from "node:url"

const child = fileURLToPath(new URL("../fixtures/pingSandboxChild.mjs", import.meta.url))

/**
 * A running stand-in sandbox.
 *
 * @since 1.0.0
 * @category models
 */
export interface StallableSandbox {
  /** The sandbox process id, so a suite can assert on it directly. */
  readonly pid: number
  /** The port its ping answers on. */
  readonly port: number
  /** The `PingProvider` `SandboxHealth.make` probes. */
  readonly provider: SandboxHealth.PingProvider
  /** Stops the process without killing it: the ping connects and never answers. */
  readonly stall: () => void
  /** Lets it run again. */
  readonly resume: () => void
  /** Kills it for real and waits for the operating system to reap it. */
  readonly kill: () => Promise<void>
  /** Teardown. Never throws. */
  readonly dispose: () => void
}

const readyLine = (process_: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let buffered = ""
    let stderr = ""
    const timer = setTimeout(() => reject(new Error(`sandbox child never became ready\n${stderr}`)), 30_000)
    process_.stdout?.setEncoding("utf8")
    process_.stderr?.setEncoding("utf8")
    process_.stdout?.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timer)
      resolve((JSON.parse(buffered.slice(0, newline)) as { readonly port: number }).port)
    })
    process_.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    process_.once("error", (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
    process_.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`sandbox child exited with ${String(code)} before it was ready\n${stderr}`))
    })
  })

/** One ping: connect, write, and wait for the answer. Never times out itself — `probe` owns the deadline. */
const pingOnce = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.setNoDelay(true)
    socket.on("connect", () => socket.write("ping\n"))
    socket.on("data", () => {
      socket.destroy()
      resolve()
    })
    socket.on("error", (cause) => {
      socket.destroy()
      reject(cause)
    })
    socket.on("close", () => reject(new Error("sandbox closed the ping connection without answering")))
  })

/**
 * Starts a stand-in sandbox process.
 *
 * @since 1.0.0
 * @category constructors
 */
export const startStallableSandbox = async (): Promise<StallableSandbox> => {
  const process_ = spawn(process.execPath, [child], { stdio: ["ignore", "pipe", "pipe"] })
  const port = await readyLine(process_)
  const pid = process_.pid
  if (pid === undefined) throw new Error("sandbox child has no pid")

  let stalled = false
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(pid, name)
    } catch {
      // Already gone.
    }
  }

  return {
    pid,
    port,
    provider: {
      ping: Effect.tryPromise({
        try: () => pingOnce(port),
        catch: (cause) =>
          new RemoteChildProcessSpawner.ProviderError({
            code: "unavailable",
            message: cause instanceof Error ? cause.message : "sandbox ping failed",
            cause
          })
      })
    },
    stall: () => {
      stalled = true
      signal("SIGSTOP")
    },
    resume: () => {
      stalled = false
      signal("SIGCONT")
    },
    kill: async () => {
      // A stopped process does not run its exit path until it is continued, and
      // SIGKILL is not blockable but the reap still needs the scheduler.
      if (stalled) signal("SIGCONT")
      await killProcess({ pid })
    },
    dispose: () => {
      signal("SIGCONT")
      signal("SIGKILL")
    }
  }
}
