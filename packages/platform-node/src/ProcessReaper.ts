/**
 * Reaping the processes a dead host incarnation abandoned.
 *
 * Scope closure contains everything a live host still holds a handle for
 * ({@link ContainedSpawner}). It cannot contain anything after the host itself
 * is gone: a `SIGKILL`ed engine runs no finalizer, so the agents it had started
 * keep running with nobody left to signal them. The old runtime solved this by
 * recording spawned pids and sweeping them from the next process; this module
 * is that sweep over the {@link ProcessLedger.ProcessLedger}.
 *
 * The rules are narrow on purpose, because the input is a durable record that
 * outlived the process that wrote it and a pid is reused. A record is signalled
 * only when ALL of these hold:
 *
 * - it belongs to a DIFFERENT incarnation of the SAME `hostId`
 *   ({@link ProcessLedger.Service.orphans} already filters that);
 * - its owner is gone. A pid that exists but belongs to another user counts as
 *   alive, exactly as {@link HostLiveness} counts it, so only `ESRCH` reads as
 *   dead and every other answer keeps the record;
 * - it has a process group of its own. A record with `pgid: null` shared the
 *   group of the incarnation that started it, which is not a group to signal;
 * - that group is not THIS process's group, and its pid is not this process's
 *   pid. The host's real process group is read from the operating system,
 *   because a stored number can claim anything and the shell that started this
 *   host shares its group;
 * - the number still names the process the record describes. A record written
 *   before this machine booted names a pid from a pid space that no longer
 *   exists, and within one boot the recorded start time has to match the start
 *   time the operating system reports for that pid.
 *
 * The outcome of the signal is part of the record. A kill that succeeds, or
 * that reports the group is already gone, retires the record through
 * {@link ProcessLedger.Service.reaped}; a kill that FAILS for any other reason
 * leaves the record inherited so the next incarnation tries again. A record
 * refused on identity grounds is retired through
 * {@link ProcessLedger.Service.skipped}, which says in the journal that nothing
 * was signalled and stops every later incarnation re-examining a number the
 * operating system has moved on from.
 *
 * @since 0.1.0
 */
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawnSync } from "node:child_process"
import { uptime } from "node:os"

/**
 * What the operating system can say about a pid.
 *
 * `unknown` is not `dead`. A pid this host may not signal answers `EPERM`, and
 * a reaper that read that as "gone" would kill another user's children on the
 * strength of a record it cannot verify.
 *
 * @category models
 * @since 0.1.0
 */
export type Liveness = "alive" | "dead" | "unknown"

/**
 * What happened when a process group was signalled.
 *
 * @category models
 * @since 0.1.0
 */
export type KillOutcome =
  /** The signal was delivered. */
  | "signalled"
  /** There was nothing left to signal, which is the same end state. */
  | "already-gone"
  /** The signal was refused, and the record must be tried again later. */
  | "failed"

/**
 * The operating-system operations reaping needs.
 *
 * It is a seam, not an abstraction: `flows` ships exactly the two
 * implementations below and a test drives the Windows one on a POSIX host,
 * which is the only way that path is ever exercised in this repository.
 *
 * @category models
 * @since 0.1.0
 */
export interface System {
  /** Whether a pid names a process that still exists. */
  readonly isAlive: (pid: number) => Liveness
  /**
   * When the process behind a pid started, in epoch milliseconds, or
   * `undefined` when this platform cannot answer.
   */
  readonly startedAtMs: (pid: number) => number | undefined
  /** The process group THIS process belongs to, or `null` where there are none. */
  readonly ownGroup: () => number | null
  /** When this machine booted, in epoch milliseconds. */
  readonly bootedAtMs: () => number
  /** Ends an abandoned process and everything below it. */
  readonly killTree: (record: ProcessLedger.ProcessRecord) => KillOutcome
}

const errorCode = (cause: unknown): string | undefined => (cause as { readonly code?: string } | null)?.code

const liveness = (pid: number): Liveness => {
  try {
    // Signal 0 delivers nothing; it only asks whether the pid is signalable.
    process.kill(pid, 0)
    return "alive"
  } catch (cause) {
    // ESRCH is the only answer that means gone. EPERM means the process
    // exists and belongs to another user; anything else is a question this
    // host could not ask, and both keep the record rather than kill on it.
    return errorCode(cause) === "ESRCH" ? "dead" : "unknown"
  }
}

const bootedAtMs = (): number => Date.now() - Math.round(uptime() * 1000)

/**
 * The start time `ps` reports for a pid, or `undefined` when it cannot say.
 *
 * `lstart` is the one start-time column both BSD (macOS) and procps (Linux)
 * spell the same way, and it prints an absolute time rather than an elapsed
 * one, so the answer does not drift between reading it and comparing it.
 */
const startedAtMs = (pid: number): number | undefined => {
  const printed = ps("lstart", pid)
  if (printed === undefined) return undefined
  const parsed = Date.parse(printed)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** One `ps` column for one pid, or `undefined` when `ps` could not answer. */
const ps = (column: string, pid: number): string | undefined => {
  const result = spawnSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8" })
  const printed = result.status === 0 ? result.stdout.trim() : ""
  return printed === "" ? undefined : printed
}

/**
 * This process's own process group.
 *
 * Node exposes no `getpgrp`, so the answer comes from `ps`, which both BSD and
 * procps spell `pgid`. A host that cannot read it answers `null` and loses one
 * guard, which is why the pid comparison below is kept as well.
 */
const ownGroup = (): number | null => {
  const printed = ps("pgid", process.pid)
  if (printed === undefined) return null
  const parsed = Number.parseInt(printed, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Reaping on a POSIX host: one `SIGKILL` to the abandoned process group.
 *
 * The group is killed outright rather than asked politely first. `SIGTERM`
 * buys a graceful shutdown only when someone is left to wait for it, and the
 * incarnation that owned these processes is by definition gone.
 *
 * @category constructors
 * @since 0.1.0
 */
export const posixSystem: System = {
  isAlive: liveness,
  startedAtMs,
  ownGroup,
  bootedAtMs,
  killTree: (record) => {
    try {
      process.kill(-(record.pgid as number), "SIGKILL")
      return "signalled"
    } catch (cause) {
      // The group settled between the liveness check and the signal: the end
      // state is the one that was wanted. Anything else is a kill that did NOT
      // happen, and saying so is what gets the record tried again.
      return errorCode(cause) === "ESRCH" ? "already-gone" : "failed"
    }
  }
}

/**
 * Reaping on Windows, which has no process groups: `taskkill /T /F` by pid.
 *
 * Windows has no `lstart` and no process groups, so two of the guards above
 * cannot be answered here: the identity check falls back to the boot-time
 * comparison alone, and there is no own-group refusal to make. That is a
 * documented weaker guarantee, not an oversight.
 *
 * @category constructors
 * @since 0.1.0
 */
export const windowsSystem: System = {
  isAlive: liveness,
  startedAtMs: () => undefined,
  ownGroup: () => null,
  bootedAtMs,
  killTree: (record) => {
    const result = spawnSync("taskkill", ["/pid", String(record.pid), "/T", "/F"], { stdio: "ignore" })
    if (result.error !== undefined) return "failed"
    // 128 is `taskkill`'s "no such process", which is the same end state a
    // successful kill produces.
    if (result.status === 0) return "signalled"
    return result.status === 128 ? "already-gone" : "failed"
  }
}

/**
 * Selects the reaping implementation a platform needs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const systemFor = (platform: string): System => platform === "win32" ? windowsSystem : posixSystem

/**
 * How far apart a recorded start time and the operating system's may be and
 * still describe the same process.
 *
 * `lstart` has one-second granularity and the ledger writes its record just
 * after the spawn returns, so the two never agree exactly. Two seconds covers
 * the gap; a pid the operating system handed to somebody else is minutes or
 * hours away from it, not milliseconds.
 *
 * @category models
 * @since 0.1.0
 */
export const identityToleranceMs = 2000

/**
 * Reaper configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The pid this host must never signal a group for. Default `process.pid`. */
  readonly ownerPid?: number | undefined
  /** The operating-system seam. Default {@link systemFor} of `process.platform`. */
  readonly system?: System | undefined
}

/**
 * Why a record was not signalled.
 *
 * @category models
 * @since 0.1.0
 */
export type Refusal =
  /** The incarnation that started it is still running and will contain it. */
  | "owner-alive"
  /** It shared its owner's process group, so there is no group to signal. */
  | "no-group"
  /** It named this host's own process group or pid. */
  | "own-group"
  /** It was written before this machine booted, so the pid space is not the same. */
  | "pre-boot"
  /** The pid exists but did not start when the record says it did. */
  | "identity-mismatch"
  /** The signal was refused, so the record stays for the next incarnation. */
  | "kill-failed"

/**
 * One record, and what the reaper decided about it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reaped {
  readonly record: ProcessLedger.ProcessRecord
  readonly killed: boolean
  /** Present exactly when `killed` is `false`. */
  readonly refusal?: Refusal | undefined
}

/** The identity half of the decision, split out because it reads as a list. */
const refuseOnIdentity = (
  system: System,
  record: ProcessLedger.ProcessRecord,
  bootMs: number
): Refusal | undefined => {
  // A record older than this boot names a pid from a pid space that no longer
  // exists. The tolerance points BACKWARDS from the boot instant on purpose:
  // `uptime` is second-granular, so a record written moments after boot could
  // otherwise be read as predating it, and refusing to kill is the safe way to
  // be wrong.
  if (record.startedAtMs < bootMs + identityToleranceMs) return "pre-boot"
  const started = system.startedAtMs(record.pid)
  if (started === undefined) return undefined
  return Math.abs(started - record.startedAtMs) <= identityToleranceMs ? undefined : "identity-mismatch"
}

/** Everything the reaper checks before it is willing to signal a record. */
const refuse = (
  system: System,
  record: ProcessLedger.ProcessRecord,
  ownerPid: number,
  ownGroup: number | null,
  bootMs: number
): Refusal | undefined => {
  if (record.pgid === null) return "no-group"
  if (record.pgid === ownerPid || record.pid === ownerPid) return "own-group"
  if (ownGroup !== null && (record.pgid === ownGroup || record.pid === ownGroup)) return "own-group"
  if (system.isAlive(record.ownerPid) !== "dead") return "owner-alive"
  return refuseOnIdentity(system, record, bootMs)
}

/**
 * Kills the process groups a previous incarnation of this host abandoned.
 *
 * Returns one entry per inherited record so a caller can log what it decided;
 * `killed: false` carries the {@link Refusal} that produced it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reap = (
  options?: Options
): Effect.Effect<ReadonlyArray<Reaped>, never, ProcessLedger.ProcessLedger> =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger.ProcessLedger
    const system = options?.system ?? systemFor(process.platform)
    const ownerPid = options?.ownerPid ?? process.pid
    const ownGroup = system.ownGroup()
    const bootMs = system.bootedAtMs()
    const orphans = yield* ledger.orphans
    const decided: Array<Reaped> = []
    for (const record of orphans) {
      const refusal = refuse(system, record, ownerPid, ownGroup, bootMs)
      if (refusal === undefined) {
        const outcome = system.killTree(record)
        if (outcome === "failed") {
          // Nothing was killed, so nothing is retired: leaving the record
          // inherited is what makes the next incarnation try again.
          decided.push({ record, killed: false, refusal: "kill-failed" })
          continue
        }
        yield* retire(ledger.reaped(record), record.pid, "reaped")
        decided.push({ record, killed: true })
        continue
      }
      // An owner that is still alive will contain its own children, so the
      // record is not this host's to retire. Every other refusal is final and
      // says so in the journal.
      if (refusal !== "owner-alive") {
        yield* retire(ledger.skipped(record, refusal), record.pid, "reap-skipped")
      }
      decided.push({ record, killed: false, refusal })
    }
    return decided
  })

/**
 * Writes one ledger retirement, logging rather than failing the sweep.
 *
 * A retirement that does not commit is not a lost kill: the process is already
 * dead and the record stays inherited, so the next incarnation reads it, finds
 * the pid gone, and retires it then. Failing the whole sweep over it would
 * take the host down for a bookkeeping write.
 */
const retire = (
  write: Effect.Effect<void, unknown>,
  pid: number,
  what: string
): Effect.Effect<void> =>
  write.pipe(
    Effect.catch((error) => Effect.logWarning(`process reaper could not journal ${what} for ${pid}`, error))
  )

/**
 * Runs {@link reap} once while the layer is built.
 *
 * Compose it into a host layer so standing a host up is also what cleans up
 * after the incarnation that crashed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options?: Options): Layer.Layer<never, never, ProcessLedger.ProcessLedger> =>
  Layer.effectDiscard(reap(options))
