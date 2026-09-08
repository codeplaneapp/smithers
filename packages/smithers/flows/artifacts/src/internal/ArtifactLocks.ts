/**
 * Per-digest coordination for filesystem publication and removal.
 *
 * The semaphore is the cheap in-process path. A `wx` lock file is the actual
 * workspace-wide fence: every process that can mutate the object directory
 * observes it, and a crashed owner is recovered after its heartbeat expires.
 *
 * @since 1.0.0-rc.0
 */
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"
import * as Semaphore from "effect/Semaphore"

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const locks = new WeakMap<FileSystem.FileSystem, Map<string, Entry>>()

/**
 * The subdirectory of the objects directory that holds lock files and their
 * stale-owner tombstones. Named here rather than spelled in each caller so the
 * store's crash-orphan sweep reclaims exactly what this module creates.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const directoryName = ".locks"
const heartbeatEvery = "10 seconds"
const staleAfterMs = 60_000
const acquireWithin = "2 minutes"
const retryEvery = "25 millis"

const isReason = (cause: unknown, tag: PlatformError.SystemErrorTag): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === tag

const token = Effect.gen(function*() {
  const first = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  const second = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  return `${first.toString(36)}-${second.toString(36)}-${yield* Clock.currentTimeMillis}`
})

/**
 * Coordinates publication, freshening, and sweep deletion for one digest.
 * `process` is the explicit weaker mode for hosts without atomic create.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const withDigest = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  digest: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  coordination: "required" | "process" = "required"
): Effect.Effect<A, E | E2, R> =>
  // Every execution of the returned effect claims its own share of the entry,
  // which is why the whole body is suspended rather than run when `withDigest`
  // is called. A count taken at construction is wrong in both directions: an
  // effect built and discarded pins an entry nothing will ever release, and one
  // built once and run repeatedly — `ArtifactBackupLease` builds its gate once
  // and runs it on every heartbeat — retires the entry underneath a live holder,
  // so the next caller mints a second semaphore for the same digest and the two
  // serialize against nothing.
  Effect.suspend(() => {
    let byDigest = locks.get(fs)
    if (byDigest === undefined) {
      byDigest = new Map()
      locks.set(fs, byDigest)
    }
    let entry = byDigest.get(digest)
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      byDigest.set(digest, entry)
    }
    entry.users += 1
    const held = entry
    const table = byDigest

    const coordinated = coordination === "process"
      ? effect
      : Effect.gen(function*() {
        const owner = yield* token
        const lockDirectory = `${directory}/${directoryName}`
        const lockPath = `${lockDirectory}/${digest}.lock`
        yield* fs.makeDirectory(lockDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(failure))
        /**
         * Whether this call created the lock file, and therefore owes a release.
         * It is set in the same uninterruptible step that creates the file, so
         * interruption striking between the two cannot leak a lock nothing
         * releases — the only party that would ever reclaim it is a later
         * acquirer of the same digest, which may never come.
         */
        let acquired = false

        const acquire = Effect.gen(function*() {
          while (true) {
            const created = yield* Effect.uninterruptible(
              fs.writeFileString(lockPath, owner, { flag: "wx", mode: 0o600 }).pipe(
                Effect.andThen(Effect.sync(() => {
                  acquired = true
                  return true
                })),
                Effect.catch((cause): Effect.Effect<boolean, E2> =>
                  isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
                )
              )
            )
            if (created) return

            const info = yield* fs.stat(lockPath).pipe(
              Effect.map(Option.some),
              Effect.catch((cause): Effect.Effect<Option.Option<FileSystem.File.Info>, E2> =>
                isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : Effect.fail(failure(cause))
              )
            )
            if (Option.isSome(info)) {
              const modified = Option.getOrUndefined(info.value.mtime)
              const now = yield* Clock.currentTimeMillis
              if (modified !== undefined && now - modified.getTime() > staleAfterMs) {
                // This measurement and the rename below are two steps, so two
                // processes that both read the same lock as stale both reclaim
                // it and the second moves away whatever now sits at the path,
                // including the first's fresh lock. `FileSystemOptions`'
                // `coordination` documents the exposure; the heartbeat above is
                // what makes a holder that loses this way say so.
                //
                // Closing it is a protocol change, not a local edit. File
                // identity is observable — effect's `File.Info` carries `ino` —
                // but the host offers no remove-if-unchanged and no
                // rename-if-unchanged, so an identity check can only be made
                // after the move, which means the repair is another unguarded
                // rename. A sound version serializes reclamation itself, and
                // that decision belongs to a review, not to a patch here.
                const tombstone = `${lockPath}.stale-${owner}`
                const reaped = yield* fs.rename(lockPath, tombstone).pipe(
                  Effect.as(true),
                  Effect.catch((cause): Effect.Effect<boolean, E2> =>
                    isReason(cause, "NotFound") ? Effect.succeed(false) : Effect.fail(failure(cause))
                  )
                )
                if (reaped) yield* fs.remove(tombstone).pipe(Effect.ignore)
                continue
              }
            }
            yield* Effect.sleep(retryEvery)
          }
        }).pipe(
          Effect.timeout(acquireWithin),
          Effect.catchTag("TimeoutError", (cause) => Effect.fail(failure(cause)))
        )

        const release = fs.readFileString(lockPath).pipe(
          Effect.flatMap((found) => found === owner ? fs.remove(lockPath) : Effect.void),
          // A concurrent stale-lock reaper can win release. `NotFound`
          // means no lock remains for this owner to release or leak.
          Effect.catch((cause): Effect.Effect<void, E2> =>
            isReason(cause, "NotFound") ? Effect.void : Effect.fail(failure(cause))
          )
        )

        // The finalizer is attached around acquisition itself, not just around
        // the protected effect, so a lock created moments before an interruption
        // is still released. A call that never created one owes nothing and must
        // not touch a file another owner holds.
        return yield* acquire.pipe(
          Effect.andThen(Effect.scoped(Effect.gen(function*() {
            yield* Effect.forkScoped(
              Effect.gen(function*() {
                while (true) {
                  yield* Effect.sleep(heartbeatEvery)
                  // Freshen only a lock this call still owns, the same comparison
                  // the release below makes. A holder stalled past the stale
                  // bound has already been reaped and replaced, and touching that
                  // pathname anyway would hold a stranger's lock fresh forever: a
                  // replacement that is then hard-killed could never be judged
                  // stale while this zombie ran, so every later acquirer of the
                  // digest would burn the full two-minute deadline and fail.
                  const beat = yield* fs.readFileString(lockPath).pipe(
                    Effect.map((found) => found === owner ? "own" as const : "foreign" as const),
                    Effect.catch((cause) =>
                      Effect.succeed(isReason(cause, "NotFound") ? "gone" as const : "unreadable" as const)
                    )
                  )
                  if (beat === "own") {
                    const timestamp = new Date(yield* Clock.currentTimeMillis)
                    yield* Effect.ignore(fs.utimes(lockPath, timestamp, timestamp))
                    continue
                  }
                  // A read the host refused for any other reason is no evidence
                  // either way, so this beat is skipped and the next one retries.
                  // Ending the heartbeat on it would retire a lock this call
                  // still holds: the file goes stale within the minute, another
                  // process reaps it, and this holder keeps working unfenced.
                  if (beat === "unreadable") continue
                  // `gone` and `foreign` are the two states worth an operator
                  // signal: this call's lock was reaped, and possibly already
                  // replaced, while the effect it fences is still running, so
                  // the rest of that publication or sweep deletion proceeds
                  // unfenced against every other process. The heartbeat is the
                  // only party that ever observes it — the protected effect is
                  // not interrupted and the caller is not failed — so retiring
                  // the fiber silently would leave no trace at all.
                  yield* Effect.logWarning(
                    "Artifact lock was reclaimed while its holder was still running",
                    { digest, state: beat }
                  )
                  return
                }
              })
            )
            return yield* effect
          }))),
          Effect.onExit(() => acquired ? release : Effect.void)
        )
      })

    return held.semaphore.withPermit(coordinated).pipe(
      Effect.ensuring(Effect.sync(() => {
        held.users -= 1
        if (held.users === 0 && table.get(digest) === held) table.delete(digest)
      }))
    )
  })
