import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Effect, Layer, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { expect, it, vi } from "vitest"

it("keeps the supplied Windows spawner's native termination and ledger identity", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const commands: Array<ChildProcess.Command> = []
  const signals: Array<ChildProcess.KillOptions | undefined> = []
  let running = true
  try {
    // Exercise the actual factory and Windows lifecycle on any review host.
    // The supplied native handle is synthetic; this test signals no OS pid.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    vi.resetModules()
    const ProcessReaper = await import("../src/ProcessReaper.ts")
    const native = make((command) => {
      commands.push(command)
      return Effect.succeed(makeHandle({
        pid: ProcessId(4321),
        exitCode: Effect.succeed(ExitCode(7)),
        isRunning: Effect.sync(() => running),
        kill: (options) =>
          Effect.sync(() => {
            signals.push(options)
            running = false
          }),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      }))
    })
    await Effect.runPromise(Effect.gen(function*() {
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "windows-native", ownerPid: process.pid })
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        expect(ContainedSpawner.isContained(spawner)).toBe(true)
        const handle = yield* spawner.spawn(ChildProcess.make("program.exe", ["literal argument"]))
        expect(yield* ledger.live).toMatchObject([{ pid: 4321, pgid: null }])
        expect(yield* handle.exitCode).toBe(7)
        yield* handle.kill({ killSignal: "SIGINT", forceKillAfter: 17 })
      }).pipe(
        Effect.provide(ProcessReaper.layerSpawner({ graceMs: 42 })),
        Effect.provide(Layer.succeed(ChildProcessSpawner)(native)),
        Effect.provideService(ProcessLedger.ProcessLedger, ledger),
        Effect.scoped
      )
      expect(yield* ledger.live).toEqual([])
    }))
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      command: "program.exe",
      args: ["literal argument"],
      options: { killSignal: "SIGTERM", forceKillAfter: 42 }
    })
    expect(signals).toEqual([{ killSignal: "SIGINT", forceKillAfter: 17 }])
  } finally {
    Object.defineProperty(process, "platform", platform)
    vi.resetModules()
  }
})
