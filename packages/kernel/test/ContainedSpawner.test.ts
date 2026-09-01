/**
 * The containment decorator, exercised over a scripted host spawner.
 *
 * Real process containment is a platform concern and is proved against real
 * processes in `@smthrs/platform-node`. What lives here is the part that is
 * platform-independent and therefore testable without one: the command
 * rewriting that gives a release an escalation deadline, the process-group
 * bookkeeping the ledger records, and the finalizer that retires a record when
 * the spawn scope closes.
 */
import { describe, expect, it } from "@effect/vitest"
import * as JournalModule from "@smthrs/journal/Journal"
import { JournalError } from "@smthrs/journal/Journal"
import { Effect, Layer, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"

/**
 * A host spawner that records what it was handed and reports a fixed pid.
 *
 * It registers a finalizer of its own, exactly as Effect's Node spawner does:
 * the ORDER of that finalizer against the ledger's release is behavior this
 * module has to get right, and a fake without one could not show it.
 */
const hostSpawner = (
  spawned: Array<ChildProcess.Command>,
  pid = 4321,
  events?: Array<string>
) =>
  Layer.succeed(ChildProcessSpawner)(
    makeSpawner((command: ChildProcess.Command) =>
      Effect.gen(function*() {
        spawned.push(command)
        yield* Effect.addFinalizer(() => Effect.sync(() => events?.push("signalled")))
        return makeHandle({
          pid: ProcessId(pid),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.sync(() => events?.push("killed")),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )

const refused = new JournalError({ code: "journal_closed", message: "journal is gone" })

/** A ledger whose durable half refuses the writes named in `failing`. */
const brokenLedger = (
  failing: ReadonlyArray<"record" | "release">,
  events?: Array<string>
): ProcessLedger.Service => ({
  record: (spawned) =>
    failing.includes("record") ? Effect.fail(refused) : Effect.succeed({
      pid: spawned.pid,
      pgid: spawned.pgid,
      hostId: "broken",
      ownerPid: 1,
      startedAtMs: 0,
      commandDigest: spawned.commandDigest
    }),
  release: () =>
    Effect.suspend(() => {
      events?.push("released")
      return failing.includes("release") ? Effect.fail(refused) : Effect.void
    }),
  reaped: () => Effect.void,
  skipped: () => Effect.void,
  live: Effect.succeed([]),
  orphans: Effect.succeed([])
})

const options = (command: ChildProcess.Command) => command._tag === "StandardCommand" ? command.options : undefined

describe("ContainedSpawner", () => {
  it("gives a command an escalation deadline it did not have", () => {
    const contained = ContainedSpawner.withContainment(ChildProcess.make("sleep", ["30"]))
    expect(options(contained)).toMatchObject({ killSignal: "SIGTERM", forceKillAfter: 2000 })
    expect(ContainedSpawner.defaultGraceMs).toBe(2000)
  })

  it("keeps a kill policy the caller already chose", () => {
    const contained = ContainedSpawner.withContainment(
      ChildProcess.make("sleep", ["30"], { killSignal: "SIGINT", forceKillAfter: 25 })
    )
    expect(options(contained)).toMatchObject({ killSignal: "SIGINT", forceKillAfter: 25 })
  })

  it("gives every leg of a pipeline the same deadline", () => {
    const contained = ContainedSpawner.withContainment(
      ChildProcess.pipeTo(ChildProcess.make("cat", ["a"]), ChildProcess.make("wc", ["-l"])),
      { graceMs: 100 }
    )
    expect(contained._tag).toBe("PipedCommand")
    const legs = contained._tag === "PipedCommand" ? [contained.left, contained.right] : []
    expect(legs.map(options)).toEqual([
      expect.objectContaining({ forceKillAfter: 100 }),
      expect.objectContaining({ forceKillAfter: 100 })
    ])
  })

  it("reads the process group from the rightmost leg's detachment", () => {
    const detached = ChildProcess.make("sleep", ["30"])
    const shared = ChildProcess.make("sleep", ["30"], { detached: false })
    expect(ContainedSpawner.groupOf(detached, 91)).toBe(91)
    expect(ContainedSpawner.groupOf(shared, 91)).toBeNull()
    expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(detached, shared), 91)).toBeNull()
    expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(shared, detached), 91)).toBe(91)
  })

  it("records no process group on win32, where a command that says nothing is not detached", () => {
    const unset = ChildProcess.make("agent", ["--run"])
    // Effect detaches by default everywhere but win32, so a win32 record
    // claiming `pgid = pid` would name a group the child does not lead.
    expect(ContainedSpawner.groupOf(unset, 91, "win32")).toBeNull()
    expect(ContainedSpawner.groupOf(unset, 91, "darwin")).toBe(91)
    // A command that asked for detachment gets its group on every platform.
    expect(ContainedSpawner.groupOf(ChildProcess.make("agent", [], { detached: true }), 91, "win32")).toBe(91)
  })

  it.effect("records a spawn against the ledger and retires it on scope close", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "contained", ownerPid: 7 })

      const live = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
        return yield* ledger.live
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer({ graceMs: 50 }).pipe(
            Layer.provide(hostSpawner(spawned)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // The host spawner saw the rewritten command, and the ledger saw the
      // process the handle reported, keyed by the command line a grant names.
      expect(options(spawned[0]!)).toMatchObject({ forceKillAfter: 50 })
      expect(live).toEqual([
        expect.objectContaining({ pid: 4321, pgid: 4321, commandDigest: "agent --run" })
      ])
      // The scope closed, so the record is retired: nothing may reap a pid
      // this host already released.
      expect(yield* ledger.live).toEqual([])
    }))

  it.effect("announces the exit only AFTER the process has been signalled", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer({ graceMs: 50 }).pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(brokenLedger([], events)))
          )
        ),
        Effect.scoped
      )

      // Finalizers run last-registered-first, so the release has to be
      // registered FIRST to run last. A ledger that announced the exit while
      // the kill was still in its grace window would be telling the next
      // incarnation to stop looking for something still alive.
      expect(events).toEqual(["signalled", "released"])
    }))

  it.effect("refuses a spawn whose record did not commit, and signals what it started", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []
      // The public constructor keeps this test on the same in-memory and
      // durable path as production while the journal refuses every append.
      const ledger = yield* ProcessLedger.make({ hostId: "broken", ownerPid: 1 }).pipe(
        Effect.provide(JournalModule.layerNoop())
      )

      const failure = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return yield* Effect.flip(spawner.spawn(ChildProcess.make("agent", ["--run"])))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer().pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // A child nothing durable names is the exact hole containment exists to
      // close, so it is killed and the caller is told rather than left with a
      // handle to an undiscoverable process.
      expect(failure.reason._tag).toBe("Unknown")
      expect(failure.reason.method).toBe("spawn")
      expect(String(failure)).toContain("could not record this spawn durably")
      expect(events).toEqual(["killed", "signalled"])
      expect(yield* ledger.live).toEqual([])
    }))

  it.effect("closes the scope when the exit itself cannot be journaled", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer().pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(brokenLedger(["release"], events)))
          )
        ),
        Effect.scoped
      )

      // Retried, then left alone. The record stays inherited and the next
      // incarnation's reaper finds the pid already gone and retires it there,
      // which is why this one place logs instead of failing the scope close.
      expect(events).toEqual(["signalled", "released", "released", "released"])
    }))
})
