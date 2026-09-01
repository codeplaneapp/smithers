/**
 * Directory listing, flat or recursive, over a ZenFS-shaped backend.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import { platformError } from "./platformError.ts"
import { realPath } from "./realPath.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"
import type { ZenFsStatsLike } from "./ZenFsStatsLike.ts"

/**
 * The names directly inside one directory.
 *
 * @private
 */
const entriesOf = (
  fs: ZenFsPromisesLike,
  at: string
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readdir(at), catch: platformError("readDirectory", at) })

/**
 * One entry's own stats, without following a symlink when the backend can
 * avoid it. Node's recursive listing classifies entries by their directory
 * entry type, so a symlink to a directory is listed and not descended into;
 * `lstat` reproduces that. A backend with only `stat` follows the link, which
 * is why {@link collect} also carries a visited set.
 *
 * @private
 */
const inspect = (
  fs: ZenFsPromisesLike,
  at: string
): Effect.Effect<ZenFsStatsLike, PlatformError.PlatformError> => {
  const stats = fs.lstat ?? fs.stat
  return Effect.tryPromise({ try: () => stats(at), catch: platformError("readDirectory", at) })
}

/**
 * Every entry below `directory`, named relative to the directory the caller
 * asked about, depth first in backend order.
 *
 * @private
 */
const collect = (
  fs: ZenFsPromisesLike,
  directory: string,
  prefix: string,
  seen: Set<string>
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  Effect.gen(function*() {
    const collected: Array<string> = []
    for (const name of yield* entriesOf(fs, directory)) {
      const relative = prefix === "" ? name : `${prefix}/${name}`
      collected.push(relative)
      const child = `${directory}/${name}`
      const stats = yield* inspect(fs, child)
      if (!stats.isDirectory()) continue
      const canonical = yield* realPath(fs, child, "readDirectory")
      if (seen.has(canonical)) continue
      seen.add(canonical)
      collected.push(...yield* collect(fs, child, relative, seen))
    }
    return collected
  })

/**
 * Lists a directory, honouring `recursive` rather than dropping it.
 *
 * Effect documents `recursive` as "recursively list the contents of nested
 * directories", and `NodeFileSystem` honours it, so a flow that lists a tree
 * under `NodeHost` must not quietly lose every nested entry under
 * `BrowserHost`. The slice has no recursive `readdir`, so the walk is done
 * here with the members it does have, emitting the same `parent/child` shape
 * Node emits.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const readDirectory = (
  fs: ZenFsPromisesLike,
  path: string,
  options?: { readonly recursive?: boolean | undefined }
): Effect.Effect<Array<string>, PlatformError.PlatformError> =>
  options?.recursive === true
    ? Effect.flatMap(
      realPath(fs, path, "readDirectory"),
      (canonical) => collect(fs, path, "", new Set([canonical]))
    )
    : entriesOf(fs, path)
