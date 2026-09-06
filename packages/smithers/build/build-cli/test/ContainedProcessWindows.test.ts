import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Effect, PlatformError, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { afterEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  handle: undefined as ChildProcessHandle | undefined,
  commands: [] as Array<ChildProcess.Command>
}))
vi.mock("@effect/platform-node", async (original) => {
  const actual = await original<typeof import("@effect/platform-node")>()
  const { Effect, Layer } = await import("effect")
  const { ChildProcessSpawner, make } = await import("effect/unstable/process/ChildProcessSpawner")
  return {
    ...actual,
    NodeChildProcessSpawner: {
      ...actual.NodeChildProcessSpawner,
      layer: Layer.succeed(
        ChildProcessSpawner,
        make((command) =>
          Effect.sync(() => {
            state.commands.push(command)
            return state.handle!
          })
        )
      )
    }
  }
})
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

const platform = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(() => {
  Object.defineProperty(process, "platform", platform)
  state.commands.length = 0
  vi.restoreAllMocks()
})

const fixture = (running: boolean, kill: ChildProcessHandle["kill"]) => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" })
  vi.spyOn(ScopedProcess, "spawn")
  state.handle = makeHandle({
    pid: ProcessId(12345),
    exitCode: running ? Effect.never : Effect.succeed(ExitCode(0)),
    isRunning: Effect.succeed(running),
    kill,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })
  return {
    command: "git",
    args: ["literal argument"],
    cwd: "C:\\fixture",
    stdout: () => {},
    stderr: () => {}
  }
}

it("retains the Windows native spawner without sending a stop to an already exited process", async () => {
  const kill = vi.fn(() => Effect.void)
  expect(await ContainedProcess.run(fixture(false, kill))).toBe(0)
  expect(ScopedProcess.spawn).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
  expect(state.commands[0]).toMatchObject({
    _tag: "StandardCommand",
    command: "git",
    args: ["literal argument"],
    options: {
      cwd: "C:\\fixture",
      detached: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: 5000
    }
  })
})

it("delegates Windows cancellation to the existing native tree-kill implementation", async () => {
  const kill = vi.fn(() => Effect.void)
  await expect(ContainedProcess.run({ ...fixture(true, kill), timeoutMs: 20 })).rejects.toMatchObject({
    code: "timed_out"
  })
  expect(kill).toHaveBeenCalledWith({ killSignal: "SIGTERM", forceKillAfter: 5000 })
  expect(ScopedProcess.spawn).not.toHaveBeenCalled()
})

it("retains native tree-kill failures instead of announcing a successful timeout cleanup", async () => {
  const error = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "ChildProcess",
    method: "kill",
    cause: new Error("taskkill denied")
  })
  await expect(ContainedProcess.run({ ...fixture(true, () => Effect.fail(error)), timeoutMs: 20 })).rejects
    .toMatchObject({
      code: "cleanup_failed",
      cause: error
    })
})
