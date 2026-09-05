/**
 * The lock that keeps two `apply` runs from editing one project at once.
 *
 * Everything an apply run writes — the backups, the pending marker, the unit
 * artifacts, the report — lives in one report directory, and nothing in it
 * was built for two writers: run A's rollback reads a tree diff that run B's
 * writes are part of, and deletes files B just made. The lock is one file in
 * that directory, created with exclusive-create semantics and held for the
 * whole run, so the second run refuses instead of sharing it.
 *
 * A crashed run cannot remove its lock, so the file names its owner: the pid
 * and when it started. A later run that finds the lock asks the operating
 * system whether that pid is alive. Dead — and a lock that cannot be read
 * back at all — is taken over and the takeover is noted in the report; alive
 * is another run doing its job and this one exits 3, the same "parked: the
 * project is intact and there is a decision to make" answer a refused gate
 * gives.
 *
 * @since 1.0.0-rc.0
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Fs from "../internal/Fs.ts"
import { io, make, type MigrateError } from "../MigrateError.ts"

/**
 * Who holds the lock: the process, when it started, and over which project.
 *
 * `startedAt` is text rather than epoch milliseconds because the lock is a
 * file a person opens when something has gone wrong, and an ISO timestamp
 * answers "how long has this been stuck" without a calculator.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Record = Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.String,
  root: Schema.String
})

/**
 * Who holds the lock.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Record = typeof Record.Type

/**
 * A lock this process holds. The record is what release compares before it
 * removes anything: a lock is only ever removed by the run whose record it
 * carries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Held {
  readonly file: string
  readonly record: Record
  /**
   * The record of the stale lock this run took over, when it did. The caller
   * notes it in the report: a lock whose owner died mid-run is evidence the
   * project may be mid-unit, and the report is where that belongs.
   */
  readonly reclaimed: Record | undefined
}

/**
 * The lock file of one report directory.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const file = (path: Path.Path, root: string, reportDir: string): string =>
  path.join(root, ...reportDir.split("/"), "apply.lock")

/**
 * Whether the pid a lock names is a live process. A pid the process cannot
 * signal because it belongs to another user is alive; a pid that does not
 * exist, or a value that was never a pid, is not.
 */
const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as { readonly code?: unknown }).code === "EPERM"
  }
}

const refusal = (file: string, held: Record): MigrateError =>
  make(
    "apply-in-progress",
    `another apply run already holds ${file} (pid ${held.pid}, started ${held.startedAt})`,
    "wait for that run to finish; if it is gone, its lock is stale and the next run will take it over"
  )

/** The record a lock file holds, or `undefined` when it cannot be read back. */
const readRecord = (text: string): Record | undefined => {
  try {
    return Schema.decodeUnknownSync(Record)(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * Takes the apply lock of one report directory.
 *
 * Exclusive-create is the whole mutual exclusion: two runs that both reach
 * for the lock get exactly one success. A run that finds the file already
 * there reads who holds it — a live pid refuses with `apply-in-progress`,
 * while a dead one (or a record nothing can read back, which a crash halfway
 * through the write leaves) is removed and the create is retried, so the
 * takeover is itself exclusive.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const acquire = (options: {
  readonly root: string
  readonly reportDir: string
}): Effect.Effect<Held, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = file(path, options.root, options.reportDir)
    const record: Record = {
      pid: process.pid,
      startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      root: options.root
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.mapError(io(`could not create ${path.dirname(target)}`))
    )
    const attempt = (reclaimed: Record | undefined): Effect.Effect<Held, MigrateError, FileSystem.FileSystem> =>
      Effect.gen(function*() {
        const created = yield* fs.writeFileString(target, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" }).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
          Effect.mapError(io(`could not take the apply lock ${target}`))
        )
        if (created) return { file: target, record, reclaimed }
        const text = yield* Fs.optionalNotFound(fs.readFileString(target)).pipe(
          Effect.mapError(io(`could not read the apply lock ${target}`))
        )
        // It vanished between the failed create and the read: whoever held it
        // finished, so the create can simply run again.
        if (Option.isNone(text)) return yield* attempt(reclaimed)
        // A lock that cannot be read back names nobody, so there is no owner
        // to wait for. It is taken over the same way a dead pid's is.
        const held = readRecord(text.value)
        if (held !== undefined && pidAlive(held.pid)) {
          return yield* Effect.fail(refusal(target, held))
        }
        yield* fs.remove(target, { force: true }).pipe(
          Effect.mapError(io(`could not take over the stale apply lock ${target}`))
        )
        return yield* attempt(held ?? reclaimed)
      })
    return yield* attempt(undefined)
  })

/**
 * Gives the lock back. Only a lock still carrying this run's record is
 * removed: a file that has since been replaced belongs to another run, and
 * removing it would reopen the window the lock exists to close. Best effort
 * on purpose — a release that cannot complete leaves a stale lock, which the
 * next run takes over and notes, which is strictly better than masking the
 * failure the run itself ended with.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const release = (
  held: Held
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* Fs.optionalNotFound(fs.readFileString(held.file)).pipe(
      Effect.mapError(io(`could not read the apply lock ${held.file}`))
    )
    if (Option.isNone(text)) return
    const current = readRecord(text.value)
    if (current === undefined) return
    if (current.pid !== held.record.pid || current.startedAt !== held.record.startedAt) return
    yield* fs.remove(held.file, { force: true }).pipe(
      Effect.mapError(io(`could not release the apply lock ${held.file}`))
    )
  }).pipe(Effect.orElseSucceed(() => undefined))
