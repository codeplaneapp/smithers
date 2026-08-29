/**
 * Reaping real abandoned process groups.
 *
 * The reaper's whole subject is a process nobody holds a handle for, so a
 * double proves nothing here: these cases start real detached groups, record
 * them in a real journal-backed ledger under a pid that has genuinely exited,
 * and then assert the pids are gone from the operating system.
 *
 * `it.live` throughout: the waits below are real elapsed time.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalError } from "@smthrs/journal/Journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { ProcessLedger } from "@smthrs/kernel"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ProcessReaper from "../src/ProcessReaper.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-reaper-"))

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits for a pid to disappear, or gives up after `budgetMs`. */
const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(10)
  }
}

/** Reads a pid a child wrote to a file. */
const readPid = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return Number(text)
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`child never wrote ${path}`)
}

/** A detached shell that leads its own group and has a background child. */
const startOrphanGroup = async (name: string): Promise<{ leader: number; follower: number }> => {
  const pidFile = join(directory, `${name}.pid`)
  const child = spawn("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], {
    detached: true,
    stdio: "ignore"
  })
  child.unref()
  const follower = await readPid(pidFile)
  return { leader: child.pid as number, follower }
}

/** A pid that is certainly not a running process any more. */
const exitedPid = async (): Promise<number> => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" })
  const pid = child.pid as number
  await new Promise<void>((resolve) => child.on("close", () => resolve()))
  return pid
}

const cleanup = () => rmSync(directory, { recursive: true, force: true })

/** The record the Windows cases signal, which never names a real process. */
const windowsRecord = {
  pid: 4321,
  pgid: null,
  hostId: "windows",
  ownerPid: 4320,
  startedAtMs: 0,
  commandDigest: "agent.exe"
} as const

/** Runs `body` with a `ps` on PATH that prints `printed` and exits 0. */
const withPs = <A>(name: string, printed: string, body: () => A): A =>
  withShim(`ps-${name}`, "ps", `#!/bin/sh\nprintf '%s' '${printed}'\nexit 0\n`, body)

/** Runs `body` with a `taskkill` on PATH that exits with `status`. */
const withTaskkill = <A>(status: number, body: () => A): A =>
  withShim(`taskkill-${status}`, "taskkill", `#!/bin/sh\nexit ${status}\n`, body)

/** Runs `body` with one scripted executable shadowing `command` on PATH. */
const withShim = <A>(name: string, command: string, script: string, body: () => A): A => {
  const bin = join(directory, name)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, command), script)
  chmodSync(join(bin, command), 0o755)
  const previous = process.env["PATH"]
  process.env["PATH"] = `${bin}:${previous ?? ""}`
  try {
    return body()
  } finally {
    process.env["PATH"] = previous
  }
}

describe("ProcessReaper", () => {
  it.live("kills a group a dead incarnation abandoned and journals the reaping", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("abandoned"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          // The incarnation that started the process, and then died.
          const previous = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: deadOwner })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })

          // This incarnation inherits the record through the journal alone.
          const current = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap().pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))

          const journal = yield* Journal
          const page = yield* journal.entries({
            runId: ProcessLedger.hostRunId("reaped-host"),
            limit: 16
          })
          // A third incarnation must not try the same kill again.
          const third = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped).toEqual([
        {
          record: expect.objectContaining({ pid: group.leader, pgid: group.leader, ownerPid: deadOwner }),
          killed: true
        }
      ])
      expect(outcome.types).toEqual(["flows.host.process-spawned.v1", "flows.host.process-reaped.v1"])
      expect(outcome.remaining).toEqual([])

      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
      // The background process nothing ever held a handle for died with it.
      expect(yield* Effect.promise(() => waitForExit(group.follower, 2_000))).toBe(true)
    }))

  it.live("leaves a record alone while the incarnation that owns it is alive", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("owned"))

      const reaped = yield* run(
        Effect.gen(function*() {
          // `ownerPid` is this very process, which is alive by construction.
          const previous = yield* ProcessLedger.make({ hostId: "live-host", ownerPid: process.pid })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })
          const current = yield* ProcessLedger.make({ hostId: "live-host", ownerPid: 1 })
          return yield* ProcessReaper.reap({ ownerPid: 1 }).pipe(
            Effect.provideService(ProcessLedger.ProcessLedger, current)
          )
        })
      )

      expect(reaped.map((entry) => entry.killed)).toEqual([false])
      expect(reaped.map((entry) => entry.refusal)).toEqual(["owner-alive"])
      // Still running: the reaper refused to touch a live owner's child.
      expect(yield* Effect.promise(() => waitForExit(group.leader, 0))).toBe(false)
      process.kill(-group.leader, "SIGKILL")
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.effect("refuses records it must not signal", () =>
    run(
      Effect.gen(function*() {
        const deadOwner = 2_147_483_646
        const previous = yield* ProcessLedger.make({ hostId: "refusals", ownerPid: deadOwner })
        // Shared the dead incarnation's own group, so there is no group to kill.
        yield* previous.record({ pid: 11, pgid: null, commandDigest: "shared-group" })
        // Claims THIS host's group; a record can say anything.
        yield* previous.record({ pid: 12, pgid: 4242, commandDigest: "our-group" })
        // Claims this host's own pid.
        yield* previous.record({ pid: 4242, pgid: 99, commandDigest: "our-pid" })

        const current = yield* ProcessLedger.make({ hostId: "refusals", ownerPid: 1 })
        const killed: Array<number> = []
        const reaped = yield* ProcessReaper.reap({
          ownerPid: 4242,
          system: {
            ...ProcessReaper.posixSystem,
            isAlive: () => "dead",
            ownGroup: () => null,
            killTree: (record) => {
              killed.push(record.pid)
              return "signalled"
            }
          }
        }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))

        expect(reaped.map((entry) => entry.killed)).toEqual([false, false, false])
        expect(reaped.map((entry) => entry.refusal)).toEqual(["no-group", "own-group", "own-group"])
        expect(killed).toEqual([])
      })
    ))

  it("answers liveness from the operating system, and never confuses EPERM with gone", () => {
    expect(ProcessReaper.posixSystem.isAlive(process.pid)).toBe("alive")
    // ESRCH: nothing has this pid.
    expect(ProcessReaper.posixSystem.isAlive(2_147_483_646)).toBe("dead")
    // pid 1 is `launchd`/`init`, owned by root. Unless this suite runs as
    // root the answer is EPERM, which means the process is THERE. Reading
    // that as "dead" is what would let a reaper kill another user's children.
    expect(ProcessReaper.posixSystem.isAlive(1)).not.toBe("dead")
  })

  it("reads a process start time and this process's own group from the system", () => {
    const started = ProcessReaper.posixSystem.startedAtMs(process.pid)
    expect(started).toBeTypeOf("number")
    // This process started before now and after this machine booted.
    expect(started!).toBeLessThanOrEqual(Date.now() + 1000)
    expect(started!).toBeGreaterThanOrEqual(ProcessReaper.posixSystem.bootedAtMs() - 60_000)
    expect(ProcessReaper.posixSystem.startedAtMs(2_147_483_646)).toBeUndefined()
    expect(ProcessReaper.posixSystem.ownGroup()).toBeTypeOf("number")

    // A `ps` that answers with something unusable is the same as a `ps` that
    // cannot answer: no evidence, and no evidence never authorizes a kill.
    expect(withPs("garbage", "not a date", () => ProcessReaper.posixSystem.startedAtMs(process.pid)))
      .toBeUndefined()
    expect(withPs("silent", "", () => ProcessReaper.posixSystem.startedAtMs(process.pid))).toBeUndefined()
    expect(withPs("wordy", "not a number", () => ProcessReaper.posixSystem.ownGroup())).toBeNull()
    expect(withPs("mute", "", () => ProcessReaper.posixSystem.ownGroup())).toBeNull()
  })

  it("tells a group that settled apart from a signal that never left the process", () => {
    // ESRCH: nothing is there any more, which is the end state a kill wanted.
    expect(
      ProcessReaper.posixSystem.killTree({
        pid: 2_147_483_646,
        pgid: 2_147_483_646,
        hostId: "gone",
        ownerPid: 2_147_483_645,
        startedAtMs: 0,
        commandDigest: "gone"
      })
    ).toBe("already-gone")
    // Anything else is a kill that did NOT happen. A record carrying a number
    // the operating system will not accept is the cheapest way to produce one
    // without signalling a real process to prove it.
    expect(
      ProcessReaper.posixSystem.killTree({
        pid: 3,
        pgid: 2.5,
        hostId: "unsignalable",
        ownerPid: 2,
        startedAtMs: 0,
        commandDigest: "unsignalable"
      })
    ).toBe("failed")
  })

  it("ends a Windows process tree with taskkill, and reads the status it reports", () => {
    // `taskkill` does not exist on this host, so `spawnSync` reports ENOENT in
    // its result. A kill that never ran is a kill that failed.
    expect(ProcessReaper.windowsSystem.killTree(windowsRecord)).toBe("failed")

    // The three statuses `taskkill` actually returns, driven against a stand-in
    // on PATH — the same way `NodeJjClassification` scripts a fake `jj`. This
    // is the only way the Windows branch is ever exercised in this repository.
    expect(withTaskkill(0, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("signalled")
    expect(withTaskkill(128, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("already-gone")
    expect(withTaskkill(1, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("failed")

    expect(ProcessReaper.windowsSystem.startedAtMs(process.pid)).toBeUndefined()
    expect(ProcessReaper.windowsSystem.ownGroup()).toBeNull()
    expect(ProcessReaper.systemFor("win32")).toBe(ProcessReaper.windowsSystem)
    expect(ProcessReaper.systemFor("darwin")).toBe(ProcessReaper.posixSystem)
  })

  it.live("finishes the sweep when the ledger cannot record what it decided", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("unrecorded"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "unrecorded-host", ownerPid: deadOwner })
          const record = yield* previous.record({
            pid: group.leader,
            pgid: group.leader,
            commandDigest: "sh -c sleep"
          })
          const refused = new JournalError({ code: "journal_closed", message: "journal is gone" })
          const broken: ProcessLedger.Service = {
            record: () => Effect.fail(refused),
            release: () => Effect.fail(refused),
            reaped: () => Effect.fail(refused),
            skipped: () => Effect.fail(refused),
            live: Effect.succeed([]),
            orphans: Effect.succeed([record])
          }
          return yield* ProcessReaper.reap().pipe(
            Effect.provideService(ProcessLedger.ProcessLedger, broken)
          )
        })
      )

      // The kill still happened; only the bookkeeping about it did not.
      expect(reaped.map((entry) => entry.killed)).toEqual([true])
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("refuses a record that names this host's REAL process group", () =>
    Effect.gen(function*() {
      // The number a record carries is not checked against the shell that
      // started this host anywhere else: `ownerPid` arithmetic alone would let
      // a stale record kill the group this test process is running in.
      const ours = ProcessReaper.posixSystem.ownGroup()
      expect(ours).toBeTypeOf("number")
      const deadOwner = yield* Effect.promise(exitedPid)
      const killed: Array<number> = []

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "own-group", ownerPid: deadOwner })
          yield* previous.record({ pid: 987_654, pgid: ours, commandDigest: "claims our group" })
          const current = yield* ProcessLedger.make({ hostId: "own-group", ownerPid: process.pid })
          return yield* ProcessReaper.reap({
            // A pid this host does NOT have, so only the group check can save it.
            ownerPid: 987_653,
            system: {
              ...ProcessReaper.posixSystem,
              killTree: (record) => {
                killed.push(record.pgid as number)
                return "signalled"
              }
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
        })
      )

      expect(reaped.map((entry) => entry.refusal)).toEqual(["own-group"])
      expect(killed).toEqual([])
      // This process is still here, which is the point of the check.
      expect(ProcessReaper.posixSystem.isAlive(process.pid)).toBe("alive")
    }))

  it.live("retires a record written before this machine booted without signalling it", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("pre-boot"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: deadOwner })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })
          const current = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap({
            system: {
              ...ProcessReaper.posixSystem,
              // A machine that booted AFTER the record was written: the pid
              // space the record names does not exist any more.
              bootedAtMs: () => Date.now() + 60_000
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
          const journal = yield* Journal
          const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("pre-boot-host"), limit: 16 })
          const third = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped.map((entry) => entry.refusal)).toEqual(["pre-boot"])
      // Retired without a kill, and the journal says which of the two happened.
      expect(outcome.types).toEqual([
        "flows.host.process-spawned.v1",
        "flows.host.process-reap-skipped.v1"
      ])
      expect(outcome.remaining).toEqual([])
      // The group was never signalled, so it is still there for this cleanup.
      expect(ProcessReaper.posixSystem.isAlive(group.leader)).toBe("alive")
      process.kill(-group.leader, "SIGKILL")
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("refuses a pid whose process did not start when the record says it did", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("reused"))
      const deadOwner = yield* Effect.promise(exitedPid)
      const killed: Array<number> = []

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "reused-host", ownerPid: deadOwner })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })
          const current = yield* ProcessLedger.make({ hostId: "reused-host", ownerPid: process.pid })
          return yield* ProcessReaper.reap({
            system: {
              ...ProcessReaper.posixSystem,
              // The operating system says this pid has been running for an
              // hour, so it is not the process the record describes.
              startedAtMs: () => Date.now() - 3_600_000,
              killTree: (record) => {
                killed.push(record.pid)
                return "signalled"
              }
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
        })
      )

      expect(reaped.map((entry) => entry.refusal)).toEqual(["identity-mismatch"])
      expect(killed).toEqual([])
      process.kill(-group.leader, "SIGKILL")
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("leaves a record whose kill FAILED for the next incarnation to retry", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("stubborn"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: deadOwner })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })
          const current = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap({
            // A platform that cannot read a start time has only the boot
            // check, which this record passes, so the kill is attempted and
            // its refusal is the whole subject of this case.
            system: {
              ...ProcessReaper.posixSystem,
              startedAtMs: () => undefined,
              killTree: () => "failed"
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
          const journal = yield* Journal
          const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("stubborn-host"), limit: 16 })
          const third = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped.map((entry) => entry.killed)).toEqual([false])
      expect(outcome.reaped.map((entry) => entry.refusal)).toEqual(["kill-failed"])
      // Nothing claims the orphan was reaped, so it is still inherited.
      expect(outcome.types).toEqual(["flows.host.process-spawned.v1"])
      expect(outcome.remaining.map((row) => row.pid)).toEqual([group.leader])
      process.kill(-group.leader, "SIGKILL")
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("reaps while a host layer is being built", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("layered"))
      const deadOwner = yield* Effect.promise(exitedPid)

      yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "layered-host", ownerPid: deadOwner })
          yield* previous.record({ pid: group.leader, pgid: group.leader, commandDigest: "sh -c sleep" })
          const current = yield* ProcessLedger.make({ hostId: "layered-host", ownerPid: process.pid })
          yield* Effect.void.pipe(
            Effect.provide(ProcessReaper.layer()),
            Effect.provideService(ProcessLedger.ProcessLedger, current)
          )
        })
      )

      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
      expect(yield* Effect.promise(() => waitForExit(group.follower, 2_000))).toBe(true)
    }))
})

process.on("exit", cleanup)
