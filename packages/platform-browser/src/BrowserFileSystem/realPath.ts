/**
 * Canonicalization of a path inside the mounted volume.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import { platformError } from "./platformError.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * Lexically canonicalizes a path against the volume root.
 *
 * A tab has no working directory, so `.` and a relative path resolve against
 * `/` — the root of the mounted volume — rather than against an ambient cwd
 * that does not exist. `.` and `..` segments are removed, and `..` above the
 * root is dropped the way a POSIX resolver drops it.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const normalizePath = (path: string): string => {
  const resolved: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return `/${resolved.join("/")}`
}

/**
 * Resolves a path to its canonical absolute pathname, following symlinks when
 * the backend can follow them.
 *
 * Effect documents `realPath` as canonicalization, and it is load-bearing:
 * `@smthrs/kernel` resolves every guarded path through it before checking the
 * grant, so that a symlink cannot name a resource outside the workspace.
 * Returning the input verbatim would make that defense a no-op, so the
 * backend's own `realpath` is used whenever it has one. A volume without it
 * has no links to follow, and lexical normalization is then the whole answer;
 * the path is still stat'ed so a missing path fails the way Node's `realpath`
 * fails.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const realPath = (
  fs: ZenFsPromisesLike,
  path: string
): Effect.Effect<string, PlatformError.PlatformError> => {
  const normalized = normalizePath(path)
  const resolve = fs.realpath
  return resolve === undefined
    ? Effect.as(
      Effect.tryPromise({ try: () => fs.stat(normalized), catch: platformError("realPath", path) }),
      normalized
    )
    : Effect.tryPromise({ try: () => resolve(normalized), catch: platformError("realPath", path) })
}
