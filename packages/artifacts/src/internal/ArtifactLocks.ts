/**
 * In-process coordination for filesystem artifact publication and removal.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Semaphore from "effect/Semaphore"

interface Entry {
  readonly semaphore: Semaphore.Semaphore
  users: number
}

const locks = new WeakMap<FileSystem.FileSystem, Map<string, Entry>>()

/**
 * Coordinates publication, freshening, and sweep deletion for one digest.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withDigest = <A, E, R>(
  fs: FileSystem.FileSystem,
  digest: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
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
  return held.semaphore.withPermit(effect).pipe(
    Effect.ensuring(Effect.sync(() => {
      held.users -= 1
      if (held.users === 0 && table.get(digest) === held) table.delete(digest)
    }))
  )
}
