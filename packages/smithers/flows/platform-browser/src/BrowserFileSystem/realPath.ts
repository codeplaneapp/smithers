/**
 * Canonicalization of a path inside the mounted volume. Lexical collapse is
 * reserved for backends with no links to follow so a link is resolved before
 * a later `..` segment chooses its parent.
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
 * Roots a relative path without changing the order in which links and parent
 * segments resolve. A tab has no cwd, so its relative names begin at `/`.
 *
 * @private
 * @since 0.1.0
 */
const rootPath = (path: string): string => path.startsWith("/") ? path : `/${path}`

/**
 * Resolves a path to its canonical absolute pathname, following symlinks when
 * the backend can follow them.
 *
 * Effect documents `realPath` as canonicalization, and it is load-bearing:
 * `@smthrs/kernel` resolves every guarded path through it before checking the
 * grant, so that a symlink cannot name a resource outside the workspace.
 * Returning the input verbatim would make that defense a no-op, so the
 * backend's own `realpath` is used whenever it has one. Its input is made
 * absolute without collapsing segments so the backend follows a link before
 * applying a later `..`. A volume without `realpath` has no links to follow,
 * so lexical normalization is deliberately the whole answer; the path is
 * still stat'ed so a missing path fails the way Node's `realpath` fails.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const realPath = (
  fs: ZenFsPromisesLike,
  path: string,
  /** The operation to blame, for a caller that canonicalizes on the way to something else. */
  method = "realPath"
): Effect.Effect<string, PlatformError.PlatformError> => {
  const resolve = fs.realpath
  // Called through `fs` rather than through the captured reference: a backend
  // whose promises API is a class instance loses `this` otherwise, and every
  // other call in this adapter goes through the object.
  if (resolve !== undefined) {
    return Effect.tryPromise({ try: () => resolve.call(fs, rootPath(path)), catch: platformError(method, path) })
  }
  const normalized = normalizePath(path)
  return Effect.as(
    Effect.tryPromise({ try: () => fs.stat(normalized), catch: platformError(method, path) }),
    normalized
  )
}
